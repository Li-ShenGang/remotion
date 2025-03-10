import {calculateATempo} from './assets/calculate-atempo';
import {ffmpegVolumeExpression} from './assets/ffmpeg-volume-expression';
import type {AssetVolume} from './assets/types';
import {DEFAULT_SAMPLE_RATE} from './sample-rate';
import {truthy} from './truthy';

export type FilterWithoutPaddingApplied = ProcessedTrack & {
	filter: string;
};

export type ProcessedTrack = {
	pad_start: string | null;
	pad_end: string | null;
};

const stringifyTrim = (trim: number) => {
	const value = trim * 1_000_000;
	const asString = `${value}us`;

	// Handle very small values such as `"6e-7us"`, those are essentially rounding errors to 0
	if (asString.includes('e-')) {
		return '0us';
	}

	return asString;
};

const trimAndSetTempo = ({
	playbackRate,
	trimLeft,
	trimRight,
	forSeamlessAacConcatenation,
	assetDuration,
}: {
	playbackRate: number;
	trimLeft: number;
	trimRight: number;
	forSeamlessAacConcatenation: boolean;
	assetDuration: number | null;
}): {
	filter: (string | null)[];
	actualTrimLeft: number;
	audibleDuration: number;
} => {
	const trimRightOrAssetDuration = assetDuration
		? Math.min(trimRight, assetDuration)
		: trimRight;

	// If we need seamless AAC stitching, we need to apply the tempo filter first
	// because the atempo filter is not frame-perfect. It creates a small offset
	// and the offset needs to be the same for all audio tracks, before processing it further.
	// This also affects the trimLeft and trimRight values, as they need to be adjusted.
	if (forSeamlessAacConcatenation) {
		const actualTrimLeft = trimLeft / playbackRate;
		const actualTrimRight = trimRightOrAssetDuration / playbackRate;

		return {
			filter: [
				calculateATempo(playbackRate),
				`atrim=${stringifyTrim(actualTrimLeft)}:${stringifyTrim(
					actualTrimRight,
				)}`,
			],
			actualTrimLeft,
			audibleDuration: actualTrimRight - actualTrimLeft,
		};
	}

	// Otherwise, we first trim and then apply playback rate, as then the atempo
	// filter needs to do less work.
	if (!forSeamlessAacConcatenation) {
		return {
			filter: [
				`atrim=${stringifyTrim(trimLeft)}:${stringifyTrim(
					trimRightOrAssetDuration,
				)}`,
				calculateATempo(playbackRate),
			],
			actualTrimLeft: trimLeft,
			audibleDuration: (trimRightOrAssetDuration - trimLeft) / playbackRate,
		};
	}

	throw new Error('This should never happen');
};

export const stringifyFfmpegFilter = ({
	trimLeft,
	trimRight,
	channels,
	startInVideo,
	volume,
	fps,
	playbackRate,
	assetDuration,
	allowAmplificationDuringRender,
	toneFrequency,
	chunkLengthInSeconds,
	forSeamlessAacConcatenation,
}: {
	trimLeft: number;
	trimRight: number;
	channels: number;
	startInVideo: number;
	volume: AssetVolume;
	fps: number;
	playbackRate: number;
	assetDuration: number | null;
	allowAmplificationDuringRender: boolean;
	toneFrequency: number | null;
	chunkLengthInSeconds: number;
	forSeamlessAacConcatenation: boolean;
}): FilterWithoutPaddingApplied | null => {
	const startInVideoSeconds = startInVideo / fps;

	if (assetDuration && trimLeft >= assetDuration) {
		return null;
	}

	if (toneFrequency !== null && (toneFrequency <= 0 || toneFrequency > 2)) {
		throw new Error(
			'toneFrequency must be a positive number between 0.01 and 2',
		);
	}

	const {
		actualTrimLeft,
		audibleDuration,
		filter: trimAndTempoFilter,
	} = trimAndSetTempo({
		playbackRate,
		forSeamlessAacConcatenation,
		assetDuration,
		trimLeft,
		trimRight,
	});

	const volumeFilter = ffmpegVolumeExpression({
		volume,
		fps,
		trimLeft: actualTrimLeft,
		allowAmplificationDuringRender,
	});

	const padAtEnd = chunkLengthInSeconds - audibleDuration - startInVideoSeconds;

	// Set as few filters as possible, as combining them can create noise
	return {
		filter:
			`[0:a]` +
			[
				`aformat=sample_fmts=s32:sample_rates=${DEFAULT_SAMPLE_RATE}`,
				// The order matters here! For speed and correctness, we first trim the audio
				...trimAndTempoFilter,
				// The timings for volume must include whatever is in atrim, unless the volume
				// filter gets applied before atrim
				volumeFilter.value === '1'
					? null
					: `volume=${volumeFilter.value}:eval=${volumeFilter.eval}`,
				toneFrequency && toneFrequency !== 1
					? `asetrate=${DEFAULT_SAMPLE_RATE}*${toneFrequency},aresample=${DEFAULT_SAMPLE_RATE},atempo=1/${toneFrequency}`
					: null,
			]
				.filter(truthy)
				.join(',') +
			`[a0]`,
		pad_end:
			padAtEnd > 0.0000001
				? 'apad=pad_len=' + Math.round(padAtEnd * DEFAULT_SAMPLE_RATE)
				: null,
		pad_start:
			// For n channels, we delay n + 1 channels.
			// This is because `ffprobe` for some audio files reports the wrong amount
			// of channels.
			// This should be fine because FFMPEG documentation states:
			// "Unused delays will be silently ignored."
			// https://ffmpeg.org/ffmpeg-filters.html#adelay
			startInVideoSeconds === 0
				? null
				: `adelay=${new Array(channels + 1)
						.fill((startInVideoSeconds * 1000).toFixed(0))
						.join('|')}`,
	};
};

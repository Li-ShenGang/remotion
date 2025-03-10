import type {VideoConfig} from 'remotion/no-react';
import {NoReactInternals} from 'remotion/no-react';
import type {BrowserExecutable} from './browser-executable';
import type {BrowserLog} from './browser-log';
import type {HeadlessBrowser} from './browser/Browser';
import type {Page} from './browser/BrowserPage';
import {DEFAULT_TIMEOUT} from './browser/TimeoutSettings';
import {handleJavascriptException} from './error-handling/handle-javascript-exception';
import {findRemotionRoot} from './find-closest-package-json';
import {getPageAndCleanupFn} from './get-browser-instance';
import {Log} from './logger';
import type {ChromiumOptions} from './open-browser';
import type {ToOptions} from './options/option';
import type {optionsMap} from './options/options-map';
import type {RemotionServer} from './prepare-server';
import {makeOrReuseServer} from './prepare-server';
import {puppeteerEvaluateWithCatch} from './puppeteer-evaluate';
import {waitForReady} from './seek-to-frame';
import {setPropsAndEnv} from './set-props-and-env';
import {validatePuppeteerTimeout} from './validate-puppeteer-timeout';
import {wrapWithErrorHandling} from './wrap-with-error-handling';

type InternalSelectCompositionsConfig = {
	serializedInputPropsWithCustomSchema: string;
	envVariables: Record<string, string>;
	puppeteerInstance: HeadlessBrowser | undefined;
	onBrowserLog: null | ((log: BrowserLog) => void);
	browserExecutable: BrowserExecutable | null;
	chromiumOptions: ChromiumOptions;
	port: number | null;
	indent: boolean;
	server: RemotionServer | undefined;
	serveUrl: string;
	id: string;
} & ToOptions<typeof optionsMap.selectComposition>;

export type SelectCompositionOptions = {
	inputProps?: Record<string, unknown> | null;
	envVariables?: Record<string, string>;
	puppeteerInstance?: HeadlessBrowser;
	onBrowserLog?: (log: BrowserLog) => void;
	browserExecutable?: BrowserExecutable;
	chromiumOptions?: ChromiumOptions;
	port?: number | null;
	/**
	 * @deprecated Use `logLevel` instead.
	 */
	verbose?: boolean;
	serveUrl: string;
	id: string;
} & Partial<ToOptions<typeof optionsMap.selectComposition>>;

type CleanupFn = () => Promise<unknown>;

type InnerSelectCompositionConfig = Omit<
	InternalSelectCompositionsConfig,
	'port'
> & {
	page: Page;
	port: number;
};

const innerSelectComposition = async ({
	page,
	onBrowserLog,
	serializedInputPropsWithCustomSchema,
	envVariables,
	serveUrl,
	timeoutInMilliseconds,
	port,
	id,
	indent,
	logLevel,
}: InnerSelectCompositionConfig): Promise<InternalReturnType> => {
	if (onBrowserLog) {
		page.on('console', (log) => {
			onBrowserLog({
				stackTrace: log.stackTrace(),
				text: log.text,
				type: log.type,
			});
		});
	}

	validatePuppeteerTimeout(timeoutInMilliseconds);

	await setPropsAndEnv({
		serializedInputPropsWithCustomSchema,
		envVariables,
		page,
		serveUrl,
		initialFrame: 0,
		timeoutInMilliseconds,
		proxyPort: port,
		retriesRemaining: 2,
		audioEnabled: false,
		videoEnabled: false,
		indent,
		logLevel,
	});

	await puppeteerEvaluateWithCatch({
		page,
		pageFunction: () => {
			window.remotion_setBundleMode({
				type: 'evaluation',
			});
		},
		frame: null,
		args: [],
		timeoutInMilliseconds,
	});

	await waitForReady({
		page,
		timeoutInMilliseconds,
		frame: null,
		logLevel,
		indent,
	});

	Log.verbose(
		{
			indent,
			tag: 'selectComposition()',
			logLevel,
		},
		'Running calculateMetadata()...',
	);
	const time = Date.now();
	const {value: result, size} = await puppeteerEvaluateWithCatch({
		pageFunction: (_id: string) => {
			return window.remotion_calculateComposition(_id);
		},
		frame: null,
		page,
		args: [id],
		timeoutInMilliseconds,
	});
	Log.verbose(
		{
			indent,
			tag: 'selectComposition()',
			logLevel,
		},
		`calculateMetadata() took ${Date.now() - time}ms`,
	);

	const res = result as Awaited<
		ReturnType<typeof window.remotion_calculateComposition>
	>;

	const {width, durationInFrames, fps, height, defaultCodec} = res;
	return {
		metadata: {
			id,
			width,
			height,
			fps,
			durationInFrames,
			props: NoReactInternals.deserializeJSONWithCustomFields(
				res.serializedResolvedPropsWithCustomSchema,
			),
			defaultProps: NoReactInternals.deserializeJSONWithCustomFields(
				res.serializedDefaultPropsWithCustomSchema,
			),
			defaultCodec,
		},
		propsSize: size,
	};
};

type InternalReturnType = {
	metadata: VideoConfig;
	propsSize: number;
};

export const internalSelectCompositionRaw = async (
	options: InternalSelectCompositionsConfig,
): Promise<InternalReturnType> => {
	const cleanup: CleanupFn[] = [];
	const {
		puppeteerInstance,
		browserExecutable,
		chromiumOptions,
		serveUrl: serveUrlOrWebpackUrl,
		logLevel,
		indent,
		port,
		envVariables,
		id,
		serializedInputPropsWithCustomSchema,
		onBrowserLog,
		server,
		timeoutInMilliseconds,
		offthreadVideoCacheSizeInBytes,
		binariesDirectory,
	} = options;

	const {page, cleanup: cleanupPage} = await getPageAndCleanupFn({
		passedInInstance: puppeteerInstance,
		browserExecutable,
		chromiumOptions,
		forceDeviceScaleFactor: undefined,
		indent,
		logLevel,
	});
	cleanup.push(() => cleanupPage());

	return new Promise<InternalReturnType>((resolve, reject) => {
		const onError = (err: Error) => reject(err);

		cleanup.push(
			handleJavascriptException({
				page,
				frame: null,
				onError,
			}),
		);

		makeOrReuseServer(
			options.server,
			{
				webpackConfigOrServeUrl: serveUrlOrWebpackUrl,
				port,
				remotionRoot: findRemotionRoot(),
				concurrency: 1,
				logLevel,
				indent,
				offthreadVideoCacheSizeInBytes,
				binariesDirectory,
				forceIPv4: false,
			},
			{
				onDownload: () => undefined,
				onError,
			},
		)
			.then(({server: {serveUrl, offthreadPort, sourceMap}, cleanupServer}) => {
				page.setBrowserSourceMapGetter(sourceMap);
				cleanup.push(() => cleanupServer(true));

				return innerSelectComposition({
					serveUrl,
					page,
					port: offthreadPort,
					browserExecutable,
					chromiumOptions,
					envVariables,
					id,
					serializedInputPropsWithCustomSchema,
					onBrowserLog,
					timeoutInMilliseconds,
					logLevel,
					indent,
					puppeteerInstance,
					server,
					offthreadVideoCacheSizeInBytes,
					binariesDirectory,
				});
			})

			.then((data) => {
				return resolve(data);
			})
			.catch((err) => {
				reject(err);
			})
			.finally(() => {
				cleanup.forEach((c) => {
					// Must prevent unhandled exception in cleanup function.
					// Promise has already been resolved, so we can't reject it.
					c().catch((err) => {
						console.log('Cleanup error:', err);
					});
				});
			});
	});
};

export const internalSelectComposition = wrapWithErrorHandling(
	internalSelectCompositionRaw,
);

/**
 * @description Gets a composition defined in a Remotion project based on a Webpack bundle.
 * @see [Documentation](https://www.remotion.dev/docs/renderer/select-composition)
 */
export const selectComposition = async (
	options: SelectCompositionOptions,
): Promise<VideoConfig> => {
	const {
		id,
		serveUrl,
		browserExecutable,
		chromiumOptions,
		envVariables,
		inputProps,
		onBrowserLog,
		port,
		puppeteerInstance,
		timeoutInMilliseconds,
		verbose,
		logLevel,
		offthreadVideoCacheSizeInBytes,
		binariesDirectory,
	} = options;

	const data = await internalSelectComposition({
		id,
		serveUrl,
		browserExecutable: browserExecutable ?? null,
		chromiumOptions: chromiumOptions ?? {},
		envVariables: envVariables ?? {},
		serializedInputPropsWithCustomSchema:
			NoReactInternals.serializeJSONWithDate({
				indent: undefined,
				staticBase: null,
				data: inputProps ?? {},
			}).serializedString,
		onBrowserLog: onBrowserLog ?? null,
		port: port ?? null,
		puppeteerInstance,
		timeoutInMilliseconds: timeoutInMilliseconds ?? DEFAULT_TIMEOUT,
		logLevel: logLevel ?? verbose ? 'verbose' : 'info',
		indent: false,
		server: undefined,
		offthreadVideoCacheSizeInBytes: offthreadVideoCacheSizeInBytes ?? null,
		binariesDirectory: binariesDirectory ?? null,
	});
	return data.metadata;
};

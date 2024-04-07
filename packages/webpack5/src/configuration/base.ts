import { extname, relative, resolve } from 'path';
import {
	ContextExclusionPlugin,
	DefinePlugin,
	HotModuleReplacementPlugin,
} from 'webpack';
import Config from 'webpack-chain';
import { existsSync } from 'fs';

import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import TerserPlugin from 'terser-webpack-plugin';

import { getProjectFilePath, getProjectTSConfigPath } from '../helpers/project';
import { PlatformSuffixPlugin } from '../plugins/PlatformSuffixPlugin';
import { applyFileReplacements } from '../helpers/fileReplacements';
import { addCopyRule, applyCopyRules } from '../helpers/copyRules';
import { WatchStatePlugin } from '../plugins/WatchStatePlugin';
import { hasDependency } from '../helpers/dependencies';
import { applyDotEnvPlugin } from '../helpers/dotEnv';
import { env as _env, IWebpackEnv } from '../index';
import { getValue } from '../helpers/config';
import { getIPS } from '../helpers/host';
import {
	getAvailablePlatforms,
	getAbsoluteDistPath,
	getPlatformName,
	getEntryDirPath,
	getEntryPath,
} from '../helpers/platform';

export default function (config: Config, env: IWebpackEnv = _env): Config {
	const entryPath = getEntryPath();
	const platform = getPlatformName();
	const outputPath = getAbsoluteDistPath();
	const mode = env.production ? 'production' : 'development';

	// set mode
	config.mode(mode);

	// config.stats({
	// 	logging: 'verbose'
	// })

	// package.json is generated by the CLI with runtime options
	// this ensures it's not included in the bundle, but rather
	// resolved at runtime
	config.externals(['package.json', '~/package.json']);

	// disable marking built-in node modules as external
	// since they are not available at runtime and
	// should be bundled (requires polyfills)
	// for example `npm i --save url` to
	// polyfill the node url module.
	config.set('externalsPresets', {
		node: false,
	});

	const getSourceMapType = (map: string | boolean): Config.DevTool => {
		const defaultSourceMap = 'inline-source-map';

		if (typeof map === 'undefined') {
			// source-maps disabled in production by default
			// enabled with --env.sourceMap=<type>
			if (mode === 'production') {
				// todo: we may set up SourceMapDevToolPlugin to generate external maps in production
				return false;
			}

			return defaultSourceMap;
		}

		// when --env.sourceMap=true is passed, use default
		if (typeof map === 'boolean' && map) {
			return defaultSourceMap;
		}

		// pass any type of sourceMap with --env.sourceMap=<type>
		return map as Config.DevTool;
	};

	config.devtool(getSourceMapType(env.sourceMap));

	// when using hidden-source-map, output source maps to the `platforms/{platformName}-sourceMaps` folder
	if (env.sourceMap === 'hidden-source-map') {
		const sourceMapAbsolutePath = getProjectFilePath(
			`./${
				env.buildPath ?? 'platforms'
			}/${platform}-sourceMaps/[file].map[query]`,
		);
		const sourceMapRelativePath = relative(outputPath, sourceMapAbsolutePath);
		config.output.sourceMapFilename(sourceMapRelativePath);
	}

	// todo: figure out easiest way to make "node" target work in ns
	// rather than the custom ns target implementation that's hard to maintain
	// appears to be working - but we still have to deal with HMR
	config.target('node');

	config
		.entry('bundle')
		// ensure we load nativescript globals first
		.add('@nativescript/core/globals/index')
		.add('@nativescript/core/bundle-entry-points')
		.add(entryPath);

	// Add android app components to the bundle to SBG can generate the java classes
	if (platform === 'android') {
		const appComponents = Array.isArray(env.appComponents)
			? env.appComponents
			: (env.appComponents && [env.appComponents]) || [];
		appComponents.push('@nativescript/core/ui/frame');
		appComponents.push('@nativescript/core/ui/frame/activity');
		appComponents.map((component) => {
			config.entry('bundle').add(component);
		});
	}

	// inspector_modules
	config.when(shouldIncludeInspectorModules(), (config) => {
		config
			.entry('tns_modules/inspector_modules')
			.add('@nativescript/core/inspector_modules');
	});

	config.output
		.path(outputPath)
		.pathinfo(false)
		.publicPath('')
		.libraryTarget('commonjs')
		.globalObject('global')
		.set('clean', true);

	config.watchOptions({
		ignored: [
			`${getProjectFilePath(env.buildPath ?? 'platforms')}/**`,
			`${getProjectFilePath(env.appResourcesPath ?? 'App_Resources')}/**`,
		],
	});

	// allow watching node_modules
	config.when(env.watchNodeModules, (config) => {
		config.set('snapshot', {
			managedPaths: [],
		});
	});

	// Set up Terser options
	config.optimization.minimizer('TerserPlugin').use(TerserPlugin, [
		{
			terserOptions: {
				// @ts-ignore - https://github.com/webpack-contrib/terser-webpack-plugin/pull/463 broke the types?
				compress: {
					collapse_vars: platform !== 'android',
					sequences: platform !== 'android',
					keep_infinity: true,
					drop_console: mode === 'production',
					global_defs: {
						__UGLIFIED__: true,
					},
				},
				keep_fnames: true,
				keep_classnames: true,
				format: {
					keep_quoted_props: true,
				},
			},
		},
	]);

	config.optimization.runtimeChunk('single');

	config.optimization.splitChunks({
		cacheGroups: {
			defaultVendor: {
				test: /[\\/]node_modules[\\/]/,
				priority: -10,
				name: 'vendor',
				chunks: 'all',
			},
		},
	});

	// look for loaders in
	//  - node_modules/@nativescript/webpack/dist/loaders
	//  - node_modules/@nativescript/webpack/node_modules
	//  - node_modules
	// allows for cleaner rules, without having to specify full paths to loaders
	config.resolveLoader.modules
		.add(resolve(__dirname, '../loaders'))
		.add(resolve(__dirname, '../../node_modules'))
		.add(getProjectFilePath('node_modules'))
		.add('node_modules');

	config.resolve.extensions
		.add(`.${platform}.ts`)
		.add('.ts')
		.add(`.${platform}.js`)
		.add('.js')
		.add(`.${platform}.mjs`)
		.add('.mjs')
		.add(`.${platform}.css`)
		.add('.css')
		.add(`.${platform}.scss`)
		.add('.scss')
		.add(`.${platform}.json`)
		.add('.json');

	if (platform === 'visionos') {
		// visionOS allows for both .ios and .visionos extensions
		const extensions = config.resolve.extensions.values();
		const newExtensions = [];
		extensions.forEach((ext) => {
			newExtensions.push(ext);
			if (ext.includes('visionos')) {
				newExtensions.push(ext.replace('visionos', 'ios'));
			}
		});

		config.resolve.extensions.clear().merge(newExtensions);
	}

	// base aliases
	config.resolve.alias.set('~', getEntryDirPath()).set('@', getEntryDirPath());

	// resolve symlinks
	config.resolve.symlinks(true);

	// resolve modules in project node_modules first
	// then fall-back to default node resolution (up the parent folder chain)
	config.resolve.modules
		.add(getProjectFilePath('node_modules'))
		.add('node_modules');

	config.module
		.rule('bundle')
		.enforce('post')
		.test(entryPath)
		.use('app-css-loader')
		.loader('app-css-loader')
		.options({
			// TODO: allow both visionos and ios to resolve for css
			// only resolve .ios css on visionOS for now
			// platform: platform === 'visionos' ? 'ios' : platform,
			platform,
		})
		.end();

	config.when(env.hmr, (config) => {
		config.module
			.rule('bundle')
			.use('nativescript-hot-loader')
			.loader('nativescript-hot-loader')
			.options({
				injectHMRRuntime: true,
			});
	});

	// enable profiling with --env.profile
	config.when(env.profile, (config) => {
		config.profile(true);
	});

	// worker-loader should be declared before ts-loader
	config.module
		.rule('workers')
		.test(/\.(mjs|js|ts)$/)
		.use('nativescript-worker-loader')
		.loader('nativescript-worker-loader');

	const tsConfigPath = getProjectTSConfigPath();
	const configFile = tsConfigPath
		? {
				configFile: tsConfigPath,
			}
		: undefined;

	// set up ts support
	config.module
		.rule('ts')
		.test([/\.ts$/])
		.use('ts-loader')
		.loader('ts-loader')
		.options({
			// todo: perhaps we can provide a default tsconfig
			// and use that if the project doesn't have one?
			...configFile,
			transpileOnly: true,
			allowTsInNodeModules: true,
			compilerOptions: {
				sourceMap: true,
				declaration: false,
			},
			getCustomTransformers() {
				return {
					before: [require('../transformers/NativeClass').default],
				};
			},
		});

	// Use Fork TS Checker to do type checking in a separate non-blocking process
	config.when(hasDependency('typescript'), (config) => {
		config
			.plugin('ForkTsCheckerWebpackPlugin')
			.use(ForkTsCheckerWebpackPlugin, [
				{
					async: !!env.watch,
					typescript: {
						memoryLimit: 4096,
						...configFile,
					},
				},
			]);
	});

	// set up js
	config.module
		.rule('js')
		.test(/\.js$/)
		.exclude.add(/node_modules/)
		.end();

	// config.resolve.extensions.add('.xml');
	// set up xml
	config.module
		.rule('xml')
		.test(/\.xml$/)
		.use('xml-namespace-loader')
		.loader('xml-namespace-loader');

	// default PostCSS options to use
	// projects can change settings
	// via postcss.config.js
	const postCSSOptions = {
		postcssOptions: {
			plugins: [
				// inlines @imported stylesheets
				[
					'postcss-import',
					{
						// custom resolver to resolve platform extensions in @import statements
						// ie. @import "foo.css" would import "foo.ios.css" if the platform is ios and it exists
						resolve(id, baseDir, importOptions) {
							const extensions =
								platform === 'visionos' ? [platform, 'ios'] : [platform];
							for (const platformTarget of extensions) {
								const ext = extname(id);
								const platformExt = ext ? `.${platformTarget}${ext}` : '';

								if (!id.includes(platformExt)) {
									const platformRequest = id.replace(ext, platformExt);
									const extPath = resolve(baseDir, platformRequest);

									try {
										return require.resolve(platformRequest, {
											paths: [baseDir],
										});
									} catch {}

									if (existsSync(extPath)) {
										console.log(`resolving "${id}" to "${platformRequest}"`);
										return extPath;
									}
								}
							}

							// fallback to postcss-import default resolution
							return id;
						},
					},
				],
			],
		},
	};

	// set up css
	config.module
		.rule('css')
		.test(/\.css$/)
		.use('apply-css-loader')
		.loader('apply-css-loader')
		.end()
		.use('css2json-loader')
		.loader('css2json-loader')
		.end()
		.use('postcss-loader')
		.loader('postcss-loader')
		.options(postCSSOptions);

	// set up scss
	config.module
		.rule('scss')
		.test(/\.scss$/)
		.use('apply-css-loader')
		.loader('apply-css-loader')
		.end()
		.use('css2json-loader')
		.loader('css2json-loader')
		.end()
		.use('postcss-loader')
		.loader('postcss-loader')
		.options(postCSSOptions)
		.end()
		.use('sass-loader')
		.loader('sass-loader');

	// config.plugin('NormalModuleReplacementPlugin').use(NormalModuleReplacementPlugin, [
	// 	/.*/,
	// 	request => {
	// 		if (new RegExp(`\.${platform}\..+$`).test(request.request)) {
	// 			request.rawRequest = request.rawRequest.replace(`.${platform}.`, '.')
	// 			console.log(request)
	// 		}
	// 	}
	// ])

	config.plugin('PlatformSuffixPlugin').use(PlatformSuffixPlugin, [
		{
			extensions: platform === 'visionos' ? [platform, 'ios'] : [platform],
		},
	]);

	// Makes sure that require.context will never include
	// App_Resources, regardless where they are located.
	config
		.plugin('ContextExclusionPlugin|App_Resources')
		.use(ContextExclusionPlugin, [new RegExp(`(.*)App_Resources(.*)`)]);

	// Makes sure that require.context will never include code from
	// another platform (ie .android.ts when building for ios)
	const otherPlatformsRE = getAvailablePlatforms()
		.filter((platform) => platform !== getPlatformName())
		.join('|');

	config
		.plugin('ContextExclusionPlugin|Other_Platforms')
		.use(ContextExclusionPlugin, [
			new RegExp(`\\.(${otherPlatformsRE})\\.(\\w+)$`),
		]);

	// Filter common undesirable warnings
	config.set(
		'ignoreWarnings',
		(config.get('ignoreWarnings') ?? []).concat([
			/**
			 * This rule hides
			 * +-----------------------------------------------------------------------------------------+
			 * | WARNING in ./node_modules/@angular/core/fesm2015/core.js 29714:15-102                   |
			 * | System.import() is deprecated and will be removed soon. Use import() instead.           |
			 * | For more info visit https://webpack.js.org/guides/code-splitting/                       |
			 * +-----------------------------------------------------------------------------------------+
			 */
			/System.import\(\) is deprecated/,
		]),
	);

	// todo: refine defaults
	config.plugin('DefinePlugin').use(DefinePlugin, [
		{
			__DEV__: mode === 'development',
			__NS_WEBPACK__: true,
			__NS_ENV_VERBOSE__: !!env.verbose,
			__NS_DEV_HOST_IPS__:
				mode === 'development' ? JSON.stringify(getIPS()) : `[]`,
			__CSS_PARSER__: JSON.stringify(getValue('cssParser', 'css-tree')),
			__UI_USE_XML_PARSER__: true,
			__UI_USE_EXTERNAL_RENDERER__: false,
			__ANDROID__: platform === 'android',
			__IOS__: platform === 'ios',
			__VISIONOS__: platform === 'visionos',
			__APPLE__: platform === 'ios' || platform === 'visionos',
			/* for compat only */ 'global.isAndroid': platform === 'android',
			/* for compat only */ 'global.isIOS':
				platform === 'ios' || platform === 'visionos',
			/* for compat only */ 'global.isVisionOS': platform === 'visionos',
			process: 'global.process',

			// todo: ?!?!
			// profile: '() => {}',
		},
	]);

	// enable DotEnv
	applyDotEnvPlugin(config);

	// replacements
	applyFileReplacements(config);

	// set up default copy rules
	addCopyRule('assets/**');
	addCopyRule('fonts/**');
	addCopyRule('**/*.+(jpg|png)');

	applyCopyRules(config);

	config.plugin('WatchStatePlugin').use(WatchStatePlugin);

	config.when(env.hmr, (config) => {
		config.plugin('HotModuleReplacementPlugin').use(HotModuleReplacementPlugin);
	});

	config.when(env.report, (config) => {
		config.plugin('BundleAnalyzerPlugin').use(BundleAnalyzerPlugin, [
			{
				analyzerMode: 'static',
				generateStatsFile: true,
				openAnalyzer: false,
				reportFilename: getProjectFilePath('report/report.html'),
				statsFilename: getProjectFilePath('report/stats.json'),
			},
		]);
	});

	return config;
}

function shouldIncludeInspectorModules(): boolean {
	const platform = getPlatformName();
	// todo: check if core modules are external
	// todo: check if we are testing
	return platform === 'ios' || platform === 'android';
}

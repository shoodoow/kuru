// iOS 27 stops any app built with its SDK that still runs on the app
// delegate's window alone: UIKit asserts at launch unless the app adopts the
// scene life cycle. Expo 57 ships ExpoAppSceneDelegate for this, but its
// template does not use it yet, so this plugin wires it in at prebuild.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const START_IN_DELEGATE = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function withSceneAppDelegate(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      throw new Error("with-scene-lifecycle expects a Swift AppDelegate");
    }
    let contents = config.modResults.contents;
    if (contents.includes("ExpoReactNativeFactoryProvider")) return config;

    contents = contents.replace(
      "class AppDelegate: ExpoAppDelegate {",
      "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {",
    );
    // The scene delegate makes the window and starts React Native in it.
    if (!START_IN_DELEGATE.test(contents)) {
      throw new Error("with-scene-lifecycle could not find where AppDelegate starts React Native");
    }
    contents = contents.replace(START_IN_DELEGATE, "");
    config.modResults.contents = contents;
    return config;
  });
}

function withSceneManifest(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "EXExpoAppSceneDelegate",
          },
        ],
      },
    };
    return config;
  });
}

module.exports = function withSceneLifecycle(config) {
  return withSceneManifest(withSceneAppDelegate(config));
};

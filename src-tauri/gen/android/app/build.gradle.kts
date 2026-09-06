import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing. The keystore itself lives outside the repo (~/.attackfm),
// and its passwords live in keystore.properties beside this file, which
// .gitignore already excludes - neither is ever committed. Absent the file the
// release build still assembles, just unsigned, so a checkout without the
// secrets is not broken, only unable to publish. Play rejects an unsigned
// bundle, which is the honest failure.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

/*
 * The staging build: a SECOND AttackFM, installable beside the real one.
 *
 * Jams, friends, presence and Connect all need two people, and testing them
 * meant a second phone or signing out of your own account and back in. This is
 * a separate applicationId, so Android gives it its own sandbox - its own
 * WebView storage, so its own session, its own signed-in account, and its own
 * `attackfm-device-id`, which is what makes the hub see two devices rather
 * than one. Two accounts, one phone, both live.
 *
 * Set through ORG_GRADLE_PROJECT_afmStaging, not `-PafmStaging`: `tauri
 * android build` forwards its `-- args` to CARGO, not gradle - they arrive as
 * `cargo build ... -PafmStaging=true` and the build dies there. Gradle's
 * launcher turns ORG_GRADLE_PROJECT_<name> in its own environment into a
 * project property, so it reaches the build whatever CLI is in front.
 *
 * Deliberately NOT System.getenv: a build script runs in the DAEMON, which
 * keeps the environment it was started with. A daemon that once saw
 * AFM_STAGING=true would go on stamping staging ids onto ordinary release
 * builds, days later, with nothing on screen to say so.
 *
 * A property rather than a build type or product flavour, and that is not a
 * style choice. The Rust plugin wires the native library to exactly two
 * profiles - `for (profile in listOf("debug", "release"))` in buildSrc's
 * RustPlugin.kt, hanging off `mergeUniversal<Profile>JniLibFolders`. A build
 * type named `staging` gets a merge task the plugin never attaches a rustBuild
 * to, so the APK assembles happily WITHOUT libapp_lib.so and dies on launch.
 * Flipping a property on the release type keeps every task name the plugin
 * already knows.
 *
 *   npm run android:build:staging
 *
 * Same signing key and the same server: it must reach the real hub, or the two
 * accounts cannot see each other and the exercise is pointless.
 */
val afmStaging = project.findProperty("afmStaging")?.toString() == "true"

android {
    compileSdk = 36
    namespace = "com.mattssoftware.attackfm"
    defaultConfig {
        // Staging may point at a local test hub over plain http; the real
        // release must not. (A release APK cannot sign into an http:// server
        // otherwise - by design, and easy to mistake for a bug.)
        manifestPlaceholders["usesCleartextTraffic"] = if (afmStaging) "true" else "false"
        // The suffix is the whole trick: a different applicationId is a
        // different app to Android, with its own data. `namespace` above is
        // unchanged, so no Kotlin moves.
        applicationId =
            if (afmStaging) "com.mattssoftware.attackfm.staging" else "com.mattssoftware.attackfm"
        // Told apart on the home screen and in the app switcher, where two
        // identical icons would otherwise be a coin flip.
        manifestPlaceholders["appLabel"] = if (afmStaging) "AttackFM Staging" else "AttackFM"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            val store = keystoreProperties.getProperty("storeFile")
            if (store != null) {
                storeFile = file(store)
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // Only when the properties file actually named a keystore: an
            // empty signingConfig would fail the build outright, and an
            // unsigned release bundle is the more useful outcome for anyone
            // building without the secrets.
            if (keystoreProperties.getProperty("storeFile") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // MediaSessionCompat and MediaStyle: what puts this app on the lock screen,
    // in the notification's transport row, and on an Android Auto dashboard.
    // A WebView does not publish navigator.mediaSession to the system the way
    // WKWebView does on iOS, so without a session of our own the car has
    // nothing to read and nowhere to send a skip.
    implementation("androidx.media:media:1.7.0")
    // Chromecast. The framework does discovery and session plumbing; the page
    // stays the brain and drives it through CastBridge. mediarouter is named
    // outright because CastBridge talks to MediaRouter directly for its own
    // device list - the framework's MediaRouteButton UI is never used.
    // 21.5.0 rather than 22.x: the 22 line ships kotlin-stdlib 2.1 metadata,
    // which this project's Kotlin 1.9 compiler refuses to read. Every API
    // CastBridge touches is identical between the two.
    implementation("androidx.mediarouter:mediarouter:1.7.0")
    implementation("com.google.android.gms:play-services-cast-framework:21.5.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")

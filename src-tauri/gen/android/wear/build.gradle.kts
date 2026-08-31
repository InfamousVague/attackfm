// The watch, as a sibling of the phone app.
//
// Same applicationId as :app on purpose - that is how Play pairs a watch APK
// with its phone app - and the two never meet on one device, so the collision
// an equal id usually means cannot happen. Kotlin stays 1.9.25 because the
// PROJECT is pinned there (the cast framework's metadata, see :app), which
// fixes the Compose compiler at 1.5.15: the last of the K1 line.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.mattssoftware.attackfm.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mattssoftware.attackfm"
        // Wear OS 3 is the floor: everything older is a different platform in
        // all but name, and nobody's wrist still runs it.
        minSdk = 30
        // 34, not the phone's 36: wear-compose 1.3 reads the reduce_motion
        // system setting, which Android walls off from apps targeting 35+ -
        // on a real watch that is a SecurityException before the first frame.
        // Wear Play policy also trails the phone's target requirement, so
        // nothing is lost by sitting where the platform actually is.
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures { compose = true }
    // composeOptions.kotlinCompilerExtensionVersion is DEAD LETTER on this AGP:
    // 8.11 dropped the legacy wiring (the modern path is the Kotlin 2.0 compose
    // plugin, which a 1.9-pinned project cannot apply), and it ignores the
    // setting silently - the first symptom is kotlinc crashing mid-IR on
    // `remember` because no compose compiler ever ran. The plugin goes onto
    // kotlinc's classpath by hand below instead.

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    // The compose COMPILER, wired manually - see the note at buildFeatures.
    add("kotlinCompilerPluginClasspath", "androidx.compose.compiler:compiler:1.5.15")
    // The 1.6/1.3 line, NOT 1.7/1.4: Compose 1.7 is compiled against Kotlin
    // 2.x IR, and this project is pinned to Kotlin 1.9.25 (the cast
    // framework's metadata - see the root build). Mixing them dies inside the
    // compiler ("couldn't inline remember"), not at resolution, so the pin
    // here is the whole fix.
    implementation("androidx.wear.compose:compose-material:1.3.1")
    implementation("androidx.wear.compose:compose-foundation:1.3.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui:1.6.8")
    implementation("androidx.compose.runtime:runtime:1.6.8")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    // The Connect socket and every HTTP ask ride one client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}

configurations.all {
    resolutionStrategy {
        // Transitives (activity-compose, lifecycle) drag the 1.7 runtime back
        // in; hold the whole compose group on the Kotlin-1.9-compatible line.
        force("androidx.compose.runtime:runtime:1.6.8")
        force("androidx.compose.ui:ui:1.6.8")
        force("androidx.compose.foundation:foundation:1.6.8")
        force("androidx.compose.animation:animation:1.6.8")
    }
}

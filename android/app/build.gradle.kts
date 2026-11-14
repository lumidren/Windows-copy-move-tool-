plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Where the app looks for a newer release. The -P properties exist only to test the updater
// against a stand-in server on the emulator, with a made-up version number if needed:
//   ./gradlew assembleDebug -PflingoUpdateFeed=http://10.0.2.2:8129/latest -PflingoUpdateDownloads=http://10.0.2.2:8129/files/
// A build made that way is also allowed plain HTTP to the emulator's host, and nothing else.
val updateFeed = (findProperty("flingoUpdateFeed") as String?)
    ?: "https://api.github.com/repos/lumidren/Windows-copy-move-tool-/releases/latest"
val updateDownloads = (findProperty("flingoUpdateDownloads") as String?)
    ?: "https://github.com/lumidren/Windows-copy-move-tool-/releases/download/"

// Android only lets an app be replaced by one signed with the same key. The release build
// (.github/workflows/release.yml) passes the project's own key here, so every release can
// update the one before it. Without it the build is signed with Android's debug key, which
// is different on every machine: fine for trying things out, useless for updating.
val keystore: String? = System.getenv("FLINGO_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "com.lumidren.flingo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.lumidren.flingo"
        minSdk = 29
        targetSdk = 35
        versionCode = (findProperty("flingoVersionCode") as String?)?.toInt() ?: 4
        versionName = (findProperty("flingoVersionName") as String?) ?: "0.4.0"
        buildConfigField("String", "UPDATE_FEED", "\"$updateFeed\"")
        buildConfigField("String", "UPDATE_DOWNLOADS", "\"$updateDownloads\"")
        // Off in every build that is handed to anyone. With -PflingoTestHooks=true the app accepts
        // an intent that makes the scanner behave as if it had read a given code, so that what
        // happens after a scan can be tested on an emulator, whose camera cannot be aimed.
        buildConfigField("boolean", "TEST_HOOKS", ((findProperty("flingoTestHooks") as String?) == "true").toString())
        manifestPlaceholders["networkConfig"] =
            if (updateFeed.startsWith("http://")) "@xml/network_security_config_test" else "@xml/network_security_config"
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystore != null) create("stable") {
            storeFile = file(keystore)
            storePassword = System.getenv("FLINGO_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("FLINGO_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "flingo"
            keyPassword = System.getenv("FLINGO_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        debug {
            if (keystore != null) signingConfig = signingConfigs.getByName("stable")
        }
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // QR scanner for pairing. Runs on the device: no Play services, no network.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Runs on a plain JVM: contrast of the palette, and when progress is spoken aloud.
    testImplementation("junit:junit:4.13.2")
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

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
}

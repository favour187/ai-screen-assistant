import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Load signing properties from `app/signing.properties` if present (generated in CI from GitHub Secrets)
// or from env vars / gradle properties (ORG_GRADLE_PROJECT_storePassword etc.)
// Never commit keystore or properties — they are ephemeral on CI.
fun loadSigningProps(): Properties? {
    val f = File(projectDir, "signing.properties")
    if (!f.exists()) return null
    return Properties().apply { f.inputStream().use { load(it) } }
}
val signingProps = loadSigningProps()
val storeFileProp = signingProps?.getProperty("storeFile") ?: findProperty("storeFile") as? String
val storePasswordProp = signingProps?.getProperty("storePassword") ?: findProperty("storePassword") as? String ?: System.getenv("ORG_GRADLE_PROJECT_storePassword")
val keyAliasProp = signingProps?.getProperty("keyAlias") ?: findProperty("keyAlias") as? String ?: System.getenv("ORG_GRADLE_PROJECT_keyAlias")
val keyPasswordProp = signingProps?.getProperty("keyPassword") ?: findProperty("keyPassword") as? String ?: System.getenv("ORG_GRADLE_PROJECT_keyPassword")

android {
    namespace = "com.aiscreenassistant"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.aiscreenassistant"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
        // Backend is attached at build time via environment — defaults to Render
        val backendUrl = System.getenv("BACKEND_URL") ?: findProperty("backendUrl") as? String ?: "https://ai-screen-assistant.onrender.com"
        buildConfigField("String", "BACKEND_URL", "\"$backendUrl\"")
    }

    signingConfigs {
        if (storeFileProp != null && storePasswordProp != null && keyAliasProp != null && keyPasswordProp != null) {
            create("release") {
                storeFile = file(storeFileProp)
                storePassword = storePasswordProp
                keyAlias = keyAliasProp
                keyPassword = keyPasswordProp
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Use release signing only if configured via Secrets (CI); otherwise unsigned for local testing
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            isMinifyEnabled = false
            // Debug uses default debug keystore (no secret needed)
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { compose = true; buildConfig = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.13" }

    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-service:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    // Networking + serialization
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // Image & memory
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

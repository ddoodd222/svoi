plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Веб-версия из папки web/ кладётся внутрь приложения при каждой сборке.
// Приложение не грузит код из интернета: что собрано, то и работает.
val webAssets = layout.buildDirectory.dir("generated/webassets")
val copyWeb by tasks.registering(Copy::class) {
    from(rootProject.file("../web"))
    into(webAssets.map { it.dir("www") })
}

// Ключ подписи приходит из переменных окружения (в GitHub — из секретов). Без него сборка подписывается отладочным ключом.
val keystorePath: String? = System.getenv("SVOI_KEYSTORE")

android {
    namespace = "io.github.ficusficusov.svoi"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.ficusficusov.svoi"
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                storePassword = System.getenv("SVOI_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SVOI_KEY_ALIAS") ?: "svoi"
                keyPassword = System.getenv("SVOI_KEY_PASSWORD") ?: System.getenv("SVOI_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName(if (keystorePath != null) "release" else "debug")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    sourceSets["main"].assets.srcDir(webAssets.get().asFile)
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}

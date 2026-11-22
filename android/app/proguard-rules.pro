-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
-renamesourcefileattribute SourceFile

# Capacitor bridge & plugin reflection rules
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.Permission <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep public class * extends com.getcapacitor.Plugin { *; }
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
}

# App entry point, native plugin, and BuildConfig flags
-keep class com.notesplus.kapsula.MainActivity { *; }
-keep class com.notesplus.kapsula.KapsulaNativePlugin { *; }
-keep class com.notesplus.kapsula.BuildConfig { *; }

# AndroidX Biometric & Jetpack WindowManager foldables
-keep class androidx.biometric.** { *; }
-keep class androidx.window.layout.** { *; }
-keep class androidx.window.java.** { *; }
-keep class androidx.window.extensions.** { *; }
-keep class androidx.window.sidecar.** { *; }
-dontwarn androidx.window.extensions.**
-dontwarn androidx.window.sidecar.**

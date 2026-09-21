# The app is a thin WebView shell around an unmodified CyberChef bundle, so
# there is no reflection-sensitive application code to keep.
-keep class com.cyberchef.mobile.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

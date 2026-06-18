import com.launchdarkly.sdk.server.LDClient;

public class StringExample {
    // Flag-shaped text inside a string literal must NOT be detected by the AST engine.
    String doc = "client.boolVariation(\"JAVA_FAKE_IN_STRING\", ctx, false)";
}

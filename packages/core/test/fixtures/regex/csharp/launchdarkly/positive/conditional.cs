using LaunchDarkly.Sdk.Server;
using LaunchDarkly.Sdk;

// Regression fixture for the regex bug that swallowed calls inside `if (...)`
// and similar wrapping conditionals. The match index pointed at the outer
// `(`, getCallExpression captured the whole wrapped expression as arg 0,
// and the flag-key extraction failed silently. Affected every regex-based
// language, but most visibly C# where BoolVariation in `if (...)` is the
// idiomatic flag-check pattern.

public class FeatureGuards
{
    private readonly LdClient client;

    public FeatureGuards(LdClient client)
    {
        this.client = client;
    }

    public void Run(Context context)
    {
        if (client.BoolVariation("flag-in-if", context, false))
        {
            DoNew();
        }

        while (client.BoolVariation("flag-in-while", context, false))
        {
            Pump();
        }

        // JsonVariation in var assignment — the method itself was missing from the default provider.
        var config = client.JsonVariation("flag-json-config", context, LdValue.Null);
    }

    private void DoNew() { }
    private void Pump() { }
}

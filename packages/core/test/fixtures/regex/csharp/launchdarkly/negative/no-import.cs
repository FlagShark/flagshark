public class Plain
{
    public bool IsEnabled()
    {
        return BoolVariation("not-detected-without-import", false);
    }

    private bool BoolVariation(string key, bool def)
    {
        return def;
    }
}

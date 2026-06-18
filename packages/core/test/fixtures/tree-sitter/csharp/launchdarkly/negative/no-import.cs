public class NoImport
{
    public void Run(object client)
    {
        // BoolVariation call with no SDK using-directive, so the import gate skips it.
        ((LdClient)client).BoolVariation("CS_NO_IMPORT", null, false);
    }
}

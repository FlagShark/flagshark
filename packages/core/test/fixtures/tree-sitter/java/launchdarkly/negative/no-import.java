public class NoImport {
    public void run(Object client) {
        // boolVariation call with no SDK import present, so the import gate skips it.
        ((LDClient) client).boolVariation("NO_IMPORT_JAVA", null, false);
    }
}

public class Plain {
    public boolean isEnabled() {
        return boolVariation("not-detected-without-import", false);
    }

    private boolean boolVariation(String key, boolean def) {
        return def;
    }
}

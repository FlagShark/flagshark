int Plain() {
    return BoolVariation("not-detected-without-import", false);
}

int BoolVariation(const char* key, bool def) {
    return def;
}

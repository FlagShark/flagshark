class Plain {
    fun isEnabled(): Boolean {
        return boolVariation("not-detected-without-import", false)
    }

    private fun boolVariation(key: String, def: Boolean): Boolean = def
}

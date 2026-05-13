<?php
class Plain {
    public function isEnabled() {
        return $this->variation("not-detected-without-import", null, false);
    }

    public function variation($key, $ctx, $default) {
        return $default;
    }
}

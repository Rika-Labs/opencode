import fs from "fs"
import os from "os"
import path from "path"

const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-server-test-"))
process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_TEST_HOME = home
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

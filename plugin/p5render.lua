if vim.g.loaded_p5render then
  return
end
vim.g.loaded_p5render = true

-- Lightweight load: register :P5Render with defaults.
-- Users may call require("p5render").setup({ ... }) in their config to override.
require("p5render").setup()

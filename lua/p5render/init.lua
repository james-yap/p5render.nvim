local M = {}

local default_config = {
  ---@type string|nil absolute path to scripts/record.mjs; nil = auto next to plugin
  record_script = nil,
  ---@type string default dev server URL if not discovered
  url = "http://127.0.0.1:5173",
  ---@type number default capture duration (seconds)
  seconds = 4,
  ---@type number captureStream fps
  fps = 60,
  ---@type number max seconds to wait for browser POST
  timeout = 120,
  ---@type string directory under cwd for MP4s
  out_dir = "out",
  ---@type string default filename stem shown in prompt (without .mp4)
  default_name = "take",
  ---@type boolean try to parse Local: http://… from terminal buffers
  discover_url = true,
  ---@type boolean open the MP4 after success (macOS open / xdg-open)
  open_after = false,
}

local config = vim.deepcopy(default_config)

local function plugin_root()
  local src = debug.getinfo(1, "S").source:sub(2)
  -- lua/p5render/init.lua → repo root
  return vim.fn.fnamemodify(src, ":p:h:h:h")
end

local function record_script_path()
  if config.record_script and config.record_script ~= "" then
    return config.record_script
  end
  return plugin_root() .. "/scripts/record.mjs"
end

---Find a Vite-style URL in terminal buffers (newest match wins).
---@return string|nil
local function discover_dev_url()
  if not config.discover_url then
    return nil
  end
  local found = nil
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == "terminal" then
      local ok, lines = pcall(vim.api.nvim_buf_get_lines, buf, 0, -1, false)
      if ok then
        for i = #lines, 1, -1 do
          local line = lines[i]
          local u =
            line:match("(https?://localhost:%d+[%w%./_%-]*)")
            or line:match("(https?://127%.0%.0%.1:%d+[%w%./_%-]*)")
            or line:match("(https?://%[::1%]:%d+[%w%./_%-]*)")
          if u then
            -- strip trailing slash noise / path we don't want? keep origin+port only
            local origin = u:match("(https?://[^/]+)")
            found = origin or u
            break
          end
        end
      end
    end
    if found then
      break
    end
  end
  return found
end

local function ensure_out_dir(dir)
  if vim.fn.isdirectory(dir) == 0 then
    vim.fn.mkdir(dir, "p")
  end
end

local function timestamp()
  return os.date("%Y%m%d-%H%M%S")
end

---Prompt for filename stem; returns absolute mp4 path or nil if cancelled.
---@param name_hint string
---@return string|nil
local function prompt_out_path(name_hint)
  local cwd = vim.fn.getcwd()
  local dir = cwd .. "/" .. config.out_dir
  ensure_out_dir(dir)

  local hint = name_hint
  if not hint:match("%.mp4$") then
    hint = hint .. ".mp4"
  end

  local input = vim.fn.input({
    prompt = "P5Render MP4 filename: ",
    default = hint,
    completion = "file",
  })
  if input == nil or vim.trim(input) == "" then
    return nil
  end
  input = vim.trim(input)
  if not input:match("%.mp4$") then
    input = input .. ".mp4"
  end

  -- absolute or cwd-relative; if bare name, put under out/
  if input:match("^/") or input:match("^%a:[/\\]") then
    return input
  end
  if input:find("/") then
    return cwd .. "/" .. input
  end
  return dir .. "/" .. input
end

---@class P5RenderOpts
---@field url string|nil
---@field seconds number|nil
---@field fps number|nil
---@field timeout number|nil
---@field out string|nil absolute path; skips prompt when set
---@field name string|nil filename hint for prompt

---Run a render job.
---@param opts P5RenderOpts|nil
function M.render(opts)
  opts = opts or {}
  local script = record_script_path()
  if vim.fn.filereadable(script) == 0 then
    vim.notify("p5render: record script not found: " .. script, vim.log.levels.ERROR)
    return
  end

  local url = opts.url or discover_dev_url() or config.url
  local seconds = opts.seconds or config.seconds
  local fps = opts.fps or config.fps
  local timeout = opts.timeout or config.timeout

  local out = opts.out
  if not out then
    local hint = opts.name or (config.default_name .. "-" .. timestamp())
    out = prompt_out_path(hint)
    if not out then
      vim.notify("p5render: cancelled", vim.log.levels.INFO)
      return
    end
  end

  -- clear input line
  vim.cmd("redraw")

  vim.notify(
    string.format("p5render: recording %s (%ds) → %s", url, seconds, out),
    vim.log.levels.INFO
  )

  local cmd = {
    "node",
    script,
    "--url",
    url,
    "--out",
    out,
    "--seconds",
    tostring(seconds),
    "--fps",
    tostring(fps),
    "--timeout",
    tostring(timeout),
  }

  local stderr = {}
  local stdout = {}

  vim.fn.jobstart(cmd, {
    cwd = vim.fn.getcwd(),
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(stdout, line)
        end
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(stderr, line)
        end
      end
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        if code == 0 then
          vim.notify("p5render: wrote " .. out, vim.log.levels.INFO)
          if config.open_after then
            if vim.fn.has("mac") == 1 then
              vim.fn.jobstart({ "open", out }, { detach = true })
            elseif vim.fn.has("unix") == 1 then
              vim.fn.jobstart({ "xdg-open", out }, { detach = true })
            end
          end
        else
          local err = table.concat(stderr, "\n")
          if err == "" then
            err = table.concat(stdout, "\n")
          end
          vim.notify(
            "p5render: failed (" .. tostring(code) .. ")\n" .. err,
            vim.log.levels.ERROR
          )
        end
      end)
    end,
  })
end

---Setup user config and command.
---@param user table|nil
function M.setup(user)
  config = vim.tbl_deep_extend("force", default_config, user or {})

  vim.api.nvim_create_user_command("P5Render", function(o)
    local seconds = config.seconds
    local name = nil
    -- :P5Render 6
    -- :P5Render 6 myclip
    -- :P5Render myclip
    local args = vim.split(o.args or "", "%s+", { trimempty = true })
    if args[1] then
      local n = tonumber(args[1])
      if n then
        seconds = n
        name = args[2]
      else
        name = args[1]
      end
    end
    M.render({ seconds = seconds, name = name })
  end, {
    nargs = "*",
    force = true,
    desc = "Record the running p5/Vite dev server to an MP4",
  })
end

-- allow :P5Render without requiring setup()
function M.ensure_setup()
  if vim.fn.exists(":P5Render") == 2 then
    return
  end
  M.setup()
end

return M

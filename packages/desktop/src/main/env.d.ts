interface ImportMetaEnv {
  readonly MOBILECODE_UPDATER_ENABLED: string
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

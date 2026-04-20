import { defineConfig } from 'eslint/config'
import { base, typescript, prettier } from 'eslint-config-mytools'

export default defineConfig([...base, ...typescript, ...prettier])

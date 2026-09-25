import { BeastDevtoolsRspackPlugin } from '@beastjs/devtools/rspack'
import { HtmlRspackPlugin, type Configuration } from '@rspack/core'
import { beastOctane } from 'beast-tsrx/rspack'
import { fileURLToPath } from 'node:url'

const config: Configuration = {
  entry: './src/main.ts',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  experiments: { css: true },
  module: { rules: [{ test: /\.css$/u, type: 'css', use: ['postcss-loader'] }] },
  plugins: [
    new HtmlRspackPlugin({ template: './index.html' }),
    beastOctane({ octane: { profile: process.env.NODE_ENV !== 'production' } }),
    new BeastDevtoolsRspackPlugin({})
  ],
  devServer: {
    host: '127.0.0.1',
    port: 3000,
    historyApiFallback: true,
    proxy: [{ context: ['/api'], target: `http://127.0.0.1:${process.env.PORT || 8788}` }]
  }
}

export default config

const config = {
  reactStrictMode: true,
  // ssh2 optionally loads a NATIVE crypto addon (sshcrypto.node) for faster
  // handshakes. Left bundled, webpack tries to parse that binary and the build
  // fails with "Unexpected character". It is strictly an OPTIMISATION - ssh2
  // falls back to a pure-JS path when the addon is absent.
  //
  // Two consequences, both deliberate:
  //   1. externalising it keeps the binary out of the serverless bundle;
  //   2. the runtime path stays pure JS, so it works in Vercel functions.
  //      A native addon could not be loaded there anyway.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals ?? []), { ssh2: "commonjs ssh2" }];
    }
    return config;
  },
  // Vercel's Node builder copies these into the function's node_modules.
  // Without it the externalised module above is missing at runtime.
  experimental: {
    serverComponentsExternalPackages: ["ssh2"],
  },
};

export default config;

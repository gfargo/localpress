# typed: false
# frozen_string_literal: true

# This formula is maintained in the localpress repository.
# The Homebrew tap lives at https://github.com/gfargo/homebrew-tap
#
# To install:
#   brew tap gfargo/tap
#   brew install localpress
#
# Or in one step:
#   brew install gfargo/tap/localpress

class Localpress < Formula
  desc "Local-compute WordPress media optimization. Your laptop, your library."
  homepage "https://github.com/gfargo/localpress"
  version "2.1.0"
  license "MIT"

  # Bun is required at runtime but not declared as a Homebrew dependency
  # because it lives in a third-party tap (oven-sh/bun) that Homebrew won't
  # auto-tap. The wrapper script checks for bun and provides install instructions.

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64.tar.gz"
      sha256 "f8558dabd7d0dc52b481dfc1bbfd7cb85121189e39c783628fd041e8a858be43"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64.tar.gz"
      sha256 "240589ff1982b44585af429e0352aa6a45391f92270cffe7ff5349dc050d0380"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64.tar.gz"
      sha256 "1ecc2deaa79a0f76f8b8bf4571cb92e12942499e7df3c03c9230ce7338053b90"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64.tar.gz"
      sha256 "50004da001e884fd4098b897631e8753aa4aa181511a4d9a3d1d40df0b9a3540"
    end
  end

  def install
    # The tarball extracts to localpress-<platform>/ — install everything to libexec
    # so we have the bundle.js, node_modules, and wrapper script together.
    libexec.install Dir["*"]

    # Create a bin wrapper that points at the libexec wrapper
    (bin/"localpress").write <<~SCRIPT
      #!/usr/bin/env bash
      exec "#{libexec}/bin/localpress" "$@"
    SCRIPT
    (bin/"localpress").chmod 0755
  end

  def caveats
    <<~EOS
      localpress requires Bun as its runtime. If not already installed:
        brew tap oven-sh/bun && brew install bun
        # or:
        curl -fsSL https://bun.sh/install | bash

      To verify:
        localpress --version
        localpress doctor

      For updates:
        brew upgrade localpress
        # or:
        localpress update
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end

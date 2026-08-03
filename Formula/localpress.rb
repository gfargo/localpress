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
  version "2.5.0"
  license "MIT"

  # Bun is required at runtime but not declared as a Homebrew dependency
  # because it lives in a third-party tap (oven-sh/bun) that Homebrew won't
  # auto-tap. The wrapper script checks for bun and provides install instructions.

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64.tar.gz"
      sha256 "7ad04f039e7995540d8d6815fea0bf4aeb91b66001035868441871b96274a8b4"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64.tar.gz"
      sha256 "30d4e66664ed3bdb600e1e3c3e62a00a45a47aefc3ee1825adf843de5dbb650c"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64.tar.gz"
      sha256 "c2359aa6073be34fe3f00d2ff13ebd74f9cfed82506bfbad0f7ffe9bf3f79087"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64.tar.gz"
      sha256 "a68909f6367722d46837557d51ad8315034f369e8d24989c9d9dfc4a240b77e8"
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

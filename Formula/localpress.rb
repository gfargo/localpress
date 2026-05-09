# typed: false
# frozen_string_literal: true

# This formula is maintained in the localpress repository.
# The Homebrew tap lives at https://github.com/gfargo/homebrew-localpress
#
# To install:
#   brew tap gfargo/localpress
#   brew install localpress
#
# Or in one step:
#   brew install gfargo/localpress/localpress

class Localpress < Formula
  desc "Local-compute WordPress media optimization. Your laptop, your library."
  homepage "https://github.com/gfargo/localpress"
  version "1.11.2"
  license "MIT"

  # Bun is required at runtime but not declared as a Homebrew dependency
  # because it lives in a third-party tap (oven-sh/bun) that Homebrew won't
  # auto-tap. The wrapper script checks for bun and provides install instructions.

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64.tar.gz"
      sha256 "c5919d46df1117dd29c0db5688291856ddb89e73fe99512c21eccd586d21b140"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64.tar.gz"
      sha256 "b2038ea49a58cb25b6e4aaa87c93acf5d3f2000b537834bd90fedcb4e577abef"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64.tar.gz"
      sha256 "f92418972b383d50337e678b5317ed361cfb494b6a7c0ba24d04f5de900710dd"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64.tar.gz"
      sha256 "201ce1657297f76e4c4be8ed8d8f1ae2ce2c7b75bd612688e392bfc975bbcf51"
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

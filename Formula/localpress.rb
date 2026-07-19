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
  version "2.4.2"
  license "MIT"

  # Bun is required at runtime but not declared as a Homebrew dependency
  # because it lives in a third-party tap (oven-sh/bun) that Homebrew won't
  # auto-tap. The wrapper script checks for bun and provides install instructions.

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64.tar.gz"
      sha256 "abdd859524a18e604ca26f83ba1820aff2ac3283c3bb55afc38e5fc49b668888"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64.tar.gz"
      sha256 "0f0cfa929ff754a7e9e162c2c25fa11c13554ff42ff72221ffc1f5b62c128073"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64.tar.gz"
      sha256 "9d4a1924eaac870da7235d7aec9bf934ab84c914d4ec9f010940f10635b1c557"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64.tar.gz"
      sha256 "83e5667d6b86f05dd8c7779c8251a008c92d0964902b3f3dc5518f0d42d4a171"
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

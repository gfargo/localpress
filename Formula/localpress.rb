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
  version "2.7.0"
  license "MIT"

  # Bun is required at runtime but not declared as a Homebrew dependency
  # because it lives in a third-party tap (oven-sh/bun) that Homebrew won't
  # auto-tap. The wrapper script checks for bun and provides install instructions.

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64.tar.gz"
      sha256 "b98f8d7e4bb3d3249dbae94412572d57bd18b3d6da02344251b0dc0fb4dc8e98"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64.tar.gz"
      sha256 "ba4786d5ceb4aa9b00d83d6f984641cfd10d7ea4509ae0f6613f130213af18f7"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64.tar.gz"
      sha256 "4ff7d2a7dcb3aa08f995f83c5c01122190c056c55edd08305c7aec36eebf42b6"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64.tar.gz"
      sha256 "5380d77158c52b3ccda14d22a8543d9ee47efb796b72970b45ce1eae0c37f1da"
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

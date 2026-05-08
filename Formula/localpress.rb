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
  version "1.8.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "69b834435fe0ad102fcd73c905e80ef964dbc7e8a5a04fe48bd055d226c889d4"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "80ebcb98f586bdcabb63d75fb913d7c0596c8871be9a740ecfecfbb86d96ff42"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "7892d4dcbd60faa340144df426dfb16b143845d8eee43281e0d42b44e92d7c42"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "bc4eeb5d5aedeb01bdc9dcafadd0a9c81925a4a76c2e92b270312a81d3a33ff7"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end

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
  version "1.6.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "ab35769ba2debc5eb2568b56ac76c2f72087606ca197f5f70103e67070c12c0d"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "6feb86e6fe75cdf551bb4a6491998d5f75d268856096d707e0ce91fa80b1b6a5"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "c23d576fa06856a43942f72e1bec9e924d09143e9579ab139b5450a90bf4b71b"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "60094a6cde87a250cb4e978633586726a5022bd30464f46fef467a7bf5e0d8b1"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end

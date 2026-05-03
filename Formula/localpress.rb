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
  version "1.5.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-arm64"
      sha256 "9a985fa9a32d0e92dacabdcab5330bd1b26f4f7c150585e19edd076940ff5587"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-darwin-x64"
      sha256 "b522d1df5a5d5c8e87ccded664a6c40770fbf56b3718e48a6a977caa400476a1"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-arm64"
      sha256 "c8df98968266f876464ed519e94a0b2707298b595484e59e0fa269380798f742"
    end
    on_intel do
      url "https://github.com/gfargo/localpress/releases/download/v#{version}/localpress-linux-x64"
      sha256 "b3005fe5ad994be6926419f772663cdec8d28ee73e5c0c1cdb7e88a95c88e92e"
    end
  end

  def install
    bin.install Dir["localpress*"].first => "localpress"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/localpress --version")
  end
end

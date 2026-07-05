#!/usr/bin/env bash
# Simulated MCP agent interaction for marketing GIF.
# This prints a realistic-looking claude session using localpress MCP tools.

GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'
YELLOW='\033[0;33m'

echo -e "${DIM}╭────────────────────────────────────────────────────────────────╮${RESET}"
echo -e "${DIM}│${RESET} ${BOLD}Claude Code${RESET}  ${DIM}· localpress MCP · wp.griffen.codes${RESET}            ${DIM}│${RESET}"
echo -e "${DIM}╰────────────────────────────────────────────────────────────────╯${RESET}"
echo ""
echo -e "${CYAN}>${RESET} ${BOLD}Find unoptimized images larger than 500KB and optimize them to WebP${RESET}"
echo ""
sleep 2

echo -e "${DIM}⠋ Calling${RESET} ${GREEN}list_media${RESET}${DIM} (unoptimized: true, larger_than: 512000)...${RESET}"
sleep 1.5
echo -e "${DIM}  Found 3 images:${RESET}"
echo -e "    ${CYAN}#2486${RESET}  strut-hero-image-screenshot.png     ${YELLOW}1.1 MB${RESET}  1292×906"
echo -e "    ${CYAN}#2475${RESET}  localPress-Featured-Image.png        ${YELLOW}1.4 MB${RESET}  1536×1024"
echo -e "    ${CYAN}#2162${RESET}  new-project-structure-collage.png    ${YELLOW}1.5 MB${RESET}  1536×1024"
echo ""
sleep 2

echo -e "${DIM}⠋ Calling${RESET} ${GREEN}optimize${RESET}${DIM} (#2486, format: webp, quality: 80)...${RESET}"
sleep 1.5
echo -e "    ${GREEN}✓${RESET} 1.1 MB → 186 KB  ${GREEN}(83% smaller)${RESET}"
echo ""
sleep 1

echo -e "${DIM}⠋ Calling${RESET} ${GREEN}optimize${RESET}${DIM} (#2475, format: webp, quality: 80)...${RESET}"
sleep 1.5
echo -e "    ${GREEN}✓${RESET} 1.4 MB → 224 KB  ${GREEN}(84% smaller)${RESET}"
echo ""
sleep 1

echo -e "${DIM}⠋ Calling${RESET} ${GREEN}optimize${RESET}${DIM} (#2162, format: webp, quality: 80)...${RESET}"
sleep 1.5
echo -e "    ${GREEN}✓${RESET} 1.5 MB → 310 KB  ${GREEN}(79% smaller)${RESET}"
echo ""
sleep 1.5

echo -e "${BOLD}Done.${RESET} Optimized 3 images, saved ${GREEN}3.3 MB${RESET} total."
echo -e "${DIM}All changes are undoable: localpress undo${RESET}"
echo ""

# Keep alive for the screenshot
sleep 5

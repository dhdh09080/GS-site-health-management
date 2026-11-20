async def keep_print_document(page):
    """Keep Chromium's native print dialog from closing the frame before PDF assertions."""
    await page.add_init_script("""(() => {
      new MutationObserver(changes => {
        for (const change of changes) {
          for (const node of change.addedNodes) {
            if (node.id === '__printFrame') node.contentWindow.print = () => {};
          }
        }
      }).observe(document, {childList: true, subtree: true});
    })()""")

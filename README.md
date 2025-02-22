# What the heck is Context Caddy??

Context Caddy is a little vscode plugin that lets you use Claude, ChatGPT, or any other AI model on the web without having to constantly re-copy the text from the relevant files every time.

Great for those of us that don't want to pay extra for API keys to plug into tools like Cursor.

## How to do it

Install through vscode:

- Search "Context Caddy" in the extensions view from vscode or on the marketplace site and click install

Install directly:

- Download just the latest .vsix from Releases on the righthand sight of Github.
- Open the "Extensions" view in vscode and drag that .vsix file right in there! you might need to reload the app

Use:

- Select things: Use the "Project File Selector" tree (which I know looks pretty identical to the explorer tree - you might want to theme it) and click on the files you want in context. Selected files are marked with a “[x]”
- Folder buttons: In the Project File Selector each folder has two inline buttons (“All” and “None”) that select or unselect all files in that folder and its subfolders. Can be done at the top level but it might make your CPU chew for a while
- Files Selected: This is a secondary flattened view that shows what's currently in context, plus an estimated tokens (Good to keep under 50k or so for most current models in 2025). Has inline buttons to remove each file
- Profiles: Create, rename, and switch profiles so you can save different file selections and pre-prompts.
- Pre-Prompt: For the files you selected, you can use the "Pre-Prompt" to always prepend some high level project context to contents of the files you select. It's saved to the current profile
- File Tree: Toggle on or off to optionally include a minimal file tree structure to let the AI know what's going on around the files you select. Also saved to the current profile
- Copy Context: The Copy Context buttons in the menus and status bar copy your pre-prompt along with all text of the selected files plus their relative paths.

Notes:

- Highly encouraged to put a comment line on top of the files you include if they need file-level explanation for your AI rather than just the pre-prompt
- If you move, rename, or delete something, it won't appear in your copied context - It keeps things sand to save exact file paths. Reselect those files in the hierarchy when you do stuff like that.

This one saves me a bunch of time. Enjoy!

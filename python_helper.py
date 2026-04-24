import os


def combine_files(target_directory, output_file, exclude_dirs=None, exclude_files=None):
    """
    Combines all text-based files in a directory into a single file.
    """
    exclude_dirs = set(exclude_dirs or [])
    exclude_files = set(exclude_files or [])

    # Ensure the output file isn't included in its own processing
    output_filename = os.path.basename(output_file)

    with open(output_file, 'w', encoding='utf-8') as outfile:
        for root, dirs, files in os.walk(target_directory):
            
            # Modify dirs in-place to skip excluded folders
            # This prevents os.walk from even entering those folders
            dirs[:] = [d for d in dirs if d not in exclude_dirs]

            for filename in files:
                # Skip the output file itself if it's in the same folder
                if filename == output_filename:
                    continue

                file_path = os.path.join(root, filename)
                relative_path = os.path.relpath(file_path, target_directory)

                # Skip excluded files by basename or relative path
                if filename in exclude_files or relative_path in exclude_files:
                    print(f"Skipped: {relative_path} (Excluded file)")
                    continue

                try:
                    # Attempt to read the file
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as infile:
                        content = infile.read()
                        
                        # Write the separator and header
                        outfile.write("-" * 30 + "\n")
                        outfile.write(f"PATH: {relative_path}\n")
                        outfile.write("-" * 30 + "\n\n")
                        
                        # Write content
                        outfile.write(content)
                        
                        # Add spacing between files
                        outfile.write("\n\n")
                        
                    print(f"Processed: {relative_path}")
                
                except Exception as e:
                    print(f"Skipped: {relative_path} (Error: {e})")

if __name__ == "__main__":
    # --- CONFIGURATION ---
    # Use '.' for current directory or provide a full path
    SOURCE_DIRECTORY = '.' 
    
    # The name of the resulting text file
    OUTPUT_FILENAME = 'combined_contents.txt'
    
    # List folder names you want to skip (e.g., '.git', 'node_modules', '__pycache__')
    EXCLUDED_FOLDERS = {'.git', 'node_modules', '__pycache__', '.venv', '.vscode', 'dist', 'data', 'tessdata'}
    # List file names or relative file paths you want to skip
    EXCLUDED_FILES = {'package-lock.json'}
    # ---------------------

    combine_files(
        SOURCE_DIRECTORY,
        OUTPUT_FILENAME,
        exclude_dirs=EXCLUDED_FOLDERS,
        exclude_files=EXCLUDED_FILES,
    )
    print(f"\nDone! All contents saved to {OUTPUT_FILENAME}")
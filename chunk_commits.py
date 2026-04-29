import os
import subprocess
import math

# Append to .gitignore
with open('/Users/kammatiaditya/Rift/.gitignore', 'a') as f:
    f.write('\n# Added by agent\n.env.notes\n*.pem\n')

def run_cmd(cmd):
    return subprocess.check_output(cmd, shell=True).decode('utf-8').strip()

# commit the .gitignore change
run_cmd('git add .gitignore')
try:
    run_cmd('git commit -m "Update gitignore to exclude environment notes and PEM files"')
except subprocess.CalledProcessError:
    pass # might be no changes to commit if already added

# get all untracked files
files = run_cmd("git ls-files -o --exclude-standard").split('\n')
files = [f for f in files if f]

# we need around 55 commits.
target_commits = 55
if len(files) == 0:
    chunk_size = 1
else:
    chunk_size = math.ceil(len(files) / target_commits)

def generate_message(chunk):
    if len(chunk) == 1:
        f = chunk[0]
        basename = os.path.basename(f)
        return f"Add {basename}"
    else:
        basenames = [os.path.basename(f) for f in chunk]
        return f"Add {', '.join(basenames)}"

commit_count = 0
for i in range(0, len(files), chunk_size):
    chunk = files[i:i+chunk_size]
    for f in chunk:
        run_cmd(f'git add "{f}"')
    
    msg = generate_message(chunk)
    run_cmd(f'git commit -m "{msg}"')
    commit_count += 1
    print(f"Committed {len(chunk)} files: {msg}")

print(f"Total new commits: {commit_count}")

# push
print("Pushing to remote...")
try:
    print(run_cmd('git push -u origin main'))
except subprocess.CalledProcessError as e:
    print(f"Error pushing: {e.output}")
print("Done.")

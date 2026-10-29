#!/usr/bin/env python3
"""Generate a large synthetic repository for performance testing.

    scripts/big-repo.py <dir> [commits]

Uses `git fast-import`: tens of thousands of commits in seconds. History
has a main line, feature branches that fork and merge back, and a few
long-lived branches, so the graph has realistic lane counts.
"""
import os
import random
import subprocess
import sys

dest = sys.argv[1]
total = int(sys.argv[2]) if len(sys.argv) > 2 else 50_000
random.seed(7)

if os.path.exists(dest) and os.listdir(dest) and not os.path.exists(os.path.join(dest, ".gitbrix-big")):
    sys.exit(f"refusing to overwrite non-generated directory: {dest}")
os.makedirs(dest, exist_ok=True)
open(os.path.join(dest, ".gitbrix-big"), "w").close()
subprocess.run(["git", "init", "-q", "-b", "main", dest], check=True)

authors = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "Ken Thompson", "Barbara Liskov"]
out = []
mark = 0
t = 1_600_000_000
heads = {"main": None}
active = []  # feature branches: (name, mark)


def commit(branch, parents, msg, path):
    global mark, t
    mark += 1
    t += random.randint(60, 3600)
    a = random.choice(authors)
    email = a.split()[0].lower() + "@example.com"
    data = f"{msg}\n"
    out.append(f"commit refs/heads/{branch}\nmark :{mark}\n")
    out.append(f"author {a} <{email}> {t} +0000\ncommitter {a} <{email}> {t} +0000\n")
    out.append(f"data {len(data.encode())}\n{data}")
    if parents:
        out.append(f"from :{parents[0]}\n")
        for p in parents[1:]:
            out.append(f"merge :{p}\n")
    content = f"{msg} {mark}\n"
    out.append(f"M 100644 inline {path}\ndata {len(content.encode())}\n{content}\n")
    return mark


n = 0
feature_seq = 0
while n < total:
    r = random.random()
    if r < 0.08 and len(active) < 12 and heads["main"]:
        feature_seq += 1
        name = f"feature/f{feature_seq}"
        active.append([name, heads["main"]])
        continue
    if r < 0.55 and active:
        b = random.choice(active)
        b[1] = commit(b[0], [b[1]], f"Work on {b[0]} #{n}", f"src/{b[0].split('/')[1]}.txt")
        n += 1
        continue
    if r < 0.62 and active:
        b = active.pop(random.randrange(len(active)))
        heads["main"] = commit("main", [heads["main"], b[1]], f"Merge {b[0]}", "MERGES.txt")
        if random.random() < 0.7:
            out.append(f"reset refs/heads/{b[0]}\nfrom 0000000000000000000000000000000000000000\n\n")
        n += 1
        continue
    heads["main"] = commit("main", [heads["main"]] if heads["main"] else [], f"Main change #{n}", f"main/{n % 200}.txt")
    n += 1

out.append("done\n")
p = subprocess.run(["git", "-C", dest, "fast-import", "--quiet", "--done"], input="".join(out).encode())
if p.returncode:
    sys.exit(p.returncode)
subprocess.run(["git", "-C", dest, "checkout", "-q", "-f", "main"], check=True)
print(f"{total} commits in {dest}")

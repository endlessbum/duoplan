from duoplan.game.levels import level_for, title_for

for xp in (0, 99, 100, 101, 399, 400, 900, 3500):
    print(xp, level_for(xp))
print("title lvl10:", title_for(10))

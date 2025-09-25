# vulnerable_cmd.py (DO NOT use on real systems)
import os

host = input("Enter host to ping: ")

# RISKY: passing user input into shell command (shell interprets metacharacters)
os.system("ping -n 4 " + host)
import sqlite3
conn = sqlite3.connect('example.db')
cur = conn.cursor()
cur.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, password TEXT)')
cur.execute('DELETE FROM users')
cur.execute("INSERT INTO users (username, password) VALUES (?, ?)", ('alice', 'wonderland'))
conn.commit()
conn.close()
print('example.db created with one user (alice)')
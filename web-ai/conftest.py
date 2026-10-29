# Present so pytest puts the repo root on sys.path. Deliberately empty otherwise: no fixture here
# reaches beyond the fake server the tests start on this machine's own loopback, and nothing here may
# reach the internet.

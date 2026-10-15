# Present so pytest puts the repo root on sys.path. Deliberately empty otherwise: no fixture
# here should be able to reach the network, a model, or anything outside tmp_path.

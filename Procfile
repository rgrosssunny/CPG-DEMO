# Single worker: JOBS / dedup state is in-memory, so the upload and the poll
# must hit the same process. Threads handle concurrent polling fine.
web: gunicorn app:app --workers 1 --threads 4 --timeout 120 --bind 0.0.0.0:$PORT

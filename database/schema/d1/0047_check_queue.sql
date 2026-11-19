CREATE TABLE IF NOT EXISTS check_queue_control (id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL,revision TEXT NOT NULL);
INSERT INTO check_queue_control(id,json,revision) VALUES(1,'{"enabled":false,"generation":"initial","verification":null,"pending":{},"lastEnqueuedAt":null,"lastProcessedAt":null,"lastError":null}','initial');

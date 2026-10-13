require('dotenv').config();
const { initializeDatabase } = require('./lib/db');

initializeDatabase()
	.then(() => {
		console.log('Database initialized.');
		process.exit(0);
	})
	.catch((error) => {
		console.error('Database initialization failed:', error);
		process.exit(1);
	});

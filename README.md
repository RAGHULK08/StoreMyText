# StoreMyText
Store My Text
Store My Text is a secure web application designed to help you quickly save, manage, and access your text notes from anywhere. With a clean interface and robust backend, it ensures your notes are always safe and available. A key feature is its integration with Google Drive, allowing you to save your notes directly to your personal cloud storage.

Features
Secure User Authentication: Safe registration and login system to protect your notes.

Full CRUD Functionality: Create, Read, Update, and Delete your notes with ease.

Note History: View a list of all your saved notes, sorted by the most recently updated.

Dynamic Search: Instantly search through your notes by title or content.

Google Drive Integration: Securely connect your Google account using OAuth 2.0 to save your text files directly to your Google Drive.

Responsive Design: A clean and intuitive user interface that works seamlessly across devices.

Character Count: A handy counter to keep track of your text length.

Technologies Used
This project is built with a modern tech stack, ensuring reliability and scalability.

Frontend:

HTML5

CSS3

JavaScript (ES6+)

Backend:

Python 3

Flask: A lightweight WSGI web application framework.

PostgreSQL: A powerful, open-source object-relational database system.

Psycopg2: A PostgreSQL adapter for Python.

Werkzeug: For password hashing and security.

APIs & Authentication:

Google OAuth 2.0: For secure authentication with Google services.

Google Drive API: To manage files in the user's Google Drive.

Getting Started
To get a local copy up and running, follow these simple steps.

Prerequisites
Make sure you have the following installed on your system:

Python 3.8+

PostgreSQL database

git (for cloning the repository)

Installation & Setup
Clone the repository:

git clone https://github.com/your-username/your-repository-name.git
cd your-repository-name

Create and activate a virtual environment:

On macOS/Linux:

python3 -m venv venv
source venv/bin/activate

On Windows:

python -m venv venv
.\venv\Scripts\activate

Install dependencies:

pip install -r requirements.txt

Set up Environment Variables:
You will need to configure your environment variables. Create a .env file in the root directory and add the following, replacing the placeholder values with your actual credentials:

DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DBNAME"
GOOGLE_CLIENT_ID="your_google_client_id"
GOOGLE_CLIENT_SECRET="your_google_client_secret"
REDIRECT_URI="http://127.0.0.1:5000/api/auth/google/callback"

DATABASE_URL: Your PostgreSQL connection string.

GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET: Obtain these by setting up a project in the Google Cloud Console and enabling the Google Drive API. Make sure to configure the OAuth 2.0 consent screen and add the REDIRECT_URI to your authorized redirect URIs.

Initialize the Database:
Run the following command to create the necessary tables (users and notes):

flask init-db

Run the Application:
Start the Flask development server:

flask run

The application will be available at http://127.0.0.1:5000.

Usage
Open your web browser and navigate to the application's URL.

Register for a new account using your email and a secure password.

Login with your credentials.

You will be prompted to Connect Google Drive. Click the button to authorize the application.

Once authorized, you can start creating notes! Enter a title and your text content.

Click Save to Cloud to save the note.

Click View History to see, edit, or delete your previous notes.

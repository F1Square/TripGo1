const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const moment = require('moment');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const mongoose = require('mongoose');
const https = require('https');
const dotenv = require('dotenv');
dotenv.config();

// Import MongoDB models
const User = require('./models/User');
const Trip = require('./models/Trip');
const UserData = require('./models/UserData');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('Connected to MongoDB successfully');
}).catch((error) => {
    console.error('MongoDB connection error:', error);
    process.exit(1);
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'tripgo-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        maxAge: 24 * 60 * 60 * 1000 
    } // 24 hours
}));
app.use(express.static('public'));

// CSV file for exports
const csvFile = path.join(__dirname, 'Motor_Vehicle_Log.csv');

// CSV Writer setup - Excel compatible format
const csvWriter = createCsvWriter({
    path: csvFile,
    header: [
        { id: 'began', title: 'Date Trip Began' },
        { id: 'ended', title: 'Date Trip Ended' },
        { id: 'purpose', title: 'Purpose of Trip' },
        { id: 'areaFrom', title: 'Area From' },
        { id: 'areaTo', title: 'Area To' },
        { id: 'start', title: 'Odometer Reading Start' },
        { id: 'finish', title: 'Odometer Reading Finish' },
        { id: 'kilometresTravelled', title: 'Kilometres Travelled' },
        { id: 'signatureEntry', title: 'Signature of person making Entry' },
        { id: 'driverName', title: 'Name of Driver or Vehicle Registration No' },
        { id: 'fbtYear', title: 'FBT Year Ending' },
        { id: 'dateOfEntry', title: 'Date of Entry' }
    ]
});

// Authentication middleware
function authenticateToken(req, res, next) {
    const token = req.session.token || req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.username = decoded.username;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// Helper function to get user data
async function getUserData(userId) {
    try {
        let userData = await UserData.findOne({ userId });
        if (!userData) {
            userData = new UserData({
                userId,
                currentOdometer: 0,
                activeTrip: null
            });
            await userData.save();
        }
        return userData;
    } catch (error) {
        console.error('Error getting user data:', error);
        throw error;
    }
}

// Helper function to update user data
async function updateUserData(userId, data) {
    try {
        await UserData.findOneAndUpdate(
            { userId },
            { ...data },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error updating user data:', error);
        throw error;
    }
}

// Helper function to calculate seconds until next 1 AM for JWT expiration
function getSecondsUntilNext1AM() {
    const now = new Date();
    const next1AM = new Date();
    
    // Set to 1 AM today
    next1AM.setHours(1, 0, 0, 0);
    
    // If current time is already past 1 AM today, set to 1 AM tomorrow
    if (now >= next1AM) {
        next1AM.setDate(next1AM.getDate() + 1);
    }
    
    // Calculate difference in seconds
    const diffMs = next1AM.getTime() - now.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    
    console.log(`Token will expire at: ${next1AM.toLocaleString()}, in ${Math.floor(diffSeconds / 3600)} hours and ${Math.floor((diffSeconds % 3600) / 60)} minutes`);
    
    return diffSeconds;
}

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    return Math.round(distance * 100) / 100; // Round to 2 decimal places
}

// Custom rounding function based on business rule
function roundDistance(value) {
    if (typeof value !== 'number' || isNaN(value)) return 0;
    
    const decimal = value - Math.floor(value);
    
    // If decimal is 0.5 or less, round down
    if (decimal <= 0.5) {
        return Math.floor(value);
    } else {
        // If decimal is greater than 0.5, round up
        return Math.ceil(value);
    }
}

// Helper function to get area name from coordinates using reverse geocoding
async function getAreaFromCoordinates(latitude, longitude) {
    try {
        // Add a small delay to respect API rate limits (1 request per second for Nominatim)
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        // Using OpenStreetMap Nominatim API for reverse geocoding (free service)
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1`;
        
        return new Promise((resolve, reject) => {
            const options = {
                headers: {
                    'User-Agent': 'TripGo-App/1.0 (trip-tracking-application)'
                }
            };
            
            const req = https.get(url, options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        console.log('Geocoding API response status:', res.statusCode);
                        if (res.statusCode !== 200) {
                            console.error('Geocoding API error, status:', res.statusCode, 'response:', data);
                            resolve('Unknown Area');
                            return;
                        }
                        
                        const response = JSON.parse(data);
                        console.log('Parsed geocoding response:', JSON.stringify(response, null, 2));
                        
                        if (response && response.address) {
                            // Try to get city, town, village, or county
                            const area = response.address.city || 
                                        response.address.town || 
                                        response.address.village || 
                                        response.address.county || 
                                        response.address.state || 
                                        'Unknown Area';
                            console.log('Resolved area:', area);
                            resolve(area);
                        } else {
                            console.log('No address in response, using Unknown Area');
                            resolve('Unknown Area');
                        }
                    } catch (error) {
                        console.error('Error parsing geocoding response:', error);
                        console.error('Raw response data:', data);
                        resolve('Unknown Area');
                    }
                });
            }).on('error', (error) => {
                console.error('Error in reverse geocoding:', error);
                resolve('Unknown Area');
            });
            
            req.setTimeout(15000, () => {
                console.log('Geocoding request timeout - using fallback');
                req.destroy();
                resolve('Unknown Area');
            });
        });
    } catch (error) {
        console.error('Error in getAreaFromCoordinates:', error);
        return 'Unknown Area';
    }
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint for Docker
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test endpoint for geocoding
app.get('/test-geocoding/:lat/:lng', async (req, res) => {
    try {
        const { lat, lng } = req.params;
        const area = await getAreaFromCoordinates(parseFloat(lat), parseFloat(lng));
        res.json({ 
            coordinates: { lat: parseFloat(lat), lng: parseFloat(lng) },
            area: area 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to update existing trips with missing area names
app.post('/update-trip-areas', async (req, res) => {
    try {
        console.log('Starting to update trips with missing area names...');
        
        // Find trips that have coordinates but missing area names
        const tripsToUpdate = await Trip.find({
            $or: [
                { startArea: { $in: ['Unknown Area', null, undefined, ''] } },
                { endArea: { $in: ['Unknown Area', null, undefined, ''] } }
            ]
        });

        console.log(`Found ${tripsToUpdate.length} trips that need area updates`);
        let updatedCount = 0;

        for (let trip of tripsToUpdate) {
            let needsUpdate = false;
            
            // Update start area if needed
            if (trip.startLatitude && trip.startLongitude && 
                (!trip.startArea || trip.startArea === 'Unknown Area' || trip.startArea === '')) {
                console.log(`Updating start area for trip ${trip.id}`);
                trip.startArea = await getAreaFromCoordinates(trip.startLatitude, trip.startLongitude);
                needsUpdate = true;
            }
            
            // Update end area if needed (only if trip is completed)
            if (trip.endLatitude && trip.endLongitude && 
                (!trip.endArea || trip.endArea === 'Unknown Area' || trip.endArea === '')) {
                console.log(`Updating end area for trip ${trip.id}`);
                trip.endArea = await getAreaFromCoordinates(trip.endLatitude, trip.endLongitude);
                needsUpdate = true;
            }
            
            if (needsUpdate) {
                await trip.save();
                updatedCount++;
                console.log(`Updated trip ${trip.id} - Start: ${trip.startArea}, End: ${trip.endArea}`);
            }
        }

        console.log(`Update complete. Updated ${updatedCount} trips.`);
        res.json({ 
            message: `Successfully updated ${updatedCount} trips with area names`,
            totalChecked: tripsToUpdate.length,
            updated: updatedCount
        });
    } catch (error) {
        console.error('Error updating trip areas:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function for email validation
function isValidEmail(email) {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
}

// Authentication routes
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, fullName } = req.body;
        
        // Basic validation
        if (!email || !password || !fullName) {
            return res.status(400).json({ error: 'Email, password, and full name are required' });
        }

        if (!email.trim()) {
            return res.status(400).json({ error: 'Email cannot be empty' });
        }

        if (!isValidEmail(email.trim())) {
            return res.status(400).json({ error: 'Please enter a valid email address (e.g., user@example.com)' });
        }

        if (!fullName.trim()) {
            return res.status(400).json({ error: 'Full name cannot be empty' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        if (password.length > 50) {
            return res.status(400).json({ error: 'Password must be less than 50 characters' });
        }

        const emailKey = email.toLowerCase().trim();
        
        // Check if user already exists
        const existingUser = await User.findOne({ email: emailKey });
        if (existingUser) {
            return res.status(400).json({ error: 'An account with this email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const user = new User({
            email: emailKey,
            password: hashedPassword,
            fullName: fullName.trim()
        });
        
        await user.save();
        
        // Initialize user data
        await getUserData(emailKey);

        res.json({ success: true, message: 'Account created successfully! Please sign in.' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (!email.trim()) {
            return res.status(400).json({ error: 'Email cannot be empty' });
        }

        if (!isValidEmail(email.trim())) {
            return res.status(400).json({ error: 'Please enter a valid email address' });
        }

        const emailKey = email.toLowerCase().trim();
        const user = await User.findOne({ email: emailKey });
        
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password. Please check your credentials.' });
        }

        // Check password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid email or password. Please check your credentials.' });
        }

        // Generate JWT token that expires at 1 AM every night
        const secondsUntil1AM = getSecondsUntilNext1AM();
        const token = jwt.sign(
            { userId: emailKey, username: user.fullName },
            JWT_SECRET,
            { expiresIn: secondsUntil1AM }
        );

        req.session.token = token;
        req.session.userId = emailKey;

        res.json({ 
            success: true, 
            token, 
            user: { 
                email: emailKey, 
                fullName: user.fullName
            } 
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out successfully' });
});

// Get current user info
app.get('/api/user', authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.userId });
        if (user) {
            res.json({ 
                email: req.userId, 
                fullName: user.fullName
            });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user information' });
    }
});

// Get current odometer reading
app.get('/api/odometer', authenticateToken, async (req, res) => {
    try {
        const userData = await getUserData(req.userId);
        res.json({ currentOdometer: userData.currentOdometer });
    } catch (error) {
        console.error('Error fetching odometer:', error);
        res.status(500).json({ error: 'Failed to fetch odometer reading' });
    }
});

// Update odometer reading
app.post('/api/odometer', authenticateToken, async (req, res) => {
    try {
        const { odometer } = req.body;
        
        if (!odometer || isNaN(odometer) || parseFloat(odometer) < 0) {
            return res.status(400).json({ error: 'Valid odometer reading is required' });
        }
        
        const userData = await getUserData(req.userId);
        userData.currentOdometer = parseFloat(odometer);
        await userData.save();
        
        res.json({ success: true, currentOdometer: userData.currentOdometer });
    } catch (error) {
        console.error('Error updating odometer:', error);
        res.status(500).json({ error: 'Failed to update odometer reading' });
    }
});

// Start a new trip
app.post('/api/trip/start', authenticateToken, async (req, res) => {
    try {
        const { purpose, date, latitude, longitude } = req.body;
        
        // Validation
        if (!purpose || !purpose.trim()) {
            return res.status(400).json({ error: 'Purpose of trip is required' });
        }
        
        if (!date) {
            return res.status(400).json({ error: 'Trip date is required' });
        }
        
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Location coordinates are required' });
        }
        
        const userData = await getUserData(req.userId);
        
        // Check if there's already an active trip
        if (userData.activeTrip) {
            return res.status(400).json({ error: 'Please end current trip before starting a new one' });
        }
        
        // Get start area from coordinates
        const startArea = await getAreaFromCoordinates(latitude, longitude);
        console.log('Trip Start - Start Area resolved:', startArea);
        
        const newTrip = {
            id: Date.now(),
            purpose: purpose.trim(),
            startDate: date,
            startOdometer: userData.currentOdometer,
            startLatitude: latitude,
            startLongitude: longitude,
            startArea: startArea,
            startTime: new Date().toISOString(),
            active: true,
            userId: req.userId
        };
        
        console.log('Trip Start - New trip object:', JSON.stringify(newTrip, null, 2));
        
        userData.activeTrip = newTrip;
        await userData.save();
        
        res.json({ success: true, trip: newTrip });
    } catch (error) {
        console.error('Error starting trip:', error);
        res.status(500).json({ error: 'Failed to start trip' });
    }
});

// End current trip
app.post('/api/trip/end', authenticateToken, async (req, res) => {
    try {
        const { latitude, longitude, gpsDistance, actualTravelledDistance, userProvidedEndOdometer } = req.body;
        
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Location coordinates are required' });
        }
        
        const userData = await getUserData(req.userId);
        
        if (!userData.activeTrip) {
            return res.status(400).json({ error: 'No active trip found' });
        }
        
        const trip = userData.activeTrip;
        
        // Calculate straight-line distance as fallback
        const straightLineDistance = calculateDistance(
            trip.startLatitude,
            trip.startLongitude,
            latitude,
            longitude
        );
        
        // Determine the distance to use based on user input
        let finalDistance;
        let distanceSource;
        
        if (userProvidedEndOdometer !== null && userProvidedEndOdometer !== undefined) {
            // User provided end odometer reading - calculate distance from odometer difference
            finalDistance = actualTravelledDistance;
            distanceSource = 'odometer reading';
            console.log('Using user-provided odometer reading. Distance:', finalDistance, 'km');
        } else if (gpsDistance && gpsDistance > 0.01) {
            // Use GPS distance if available and reasonable
            finalDistance = gpsDistance;
            distanceSource = 'GPS tracking';
            console.log('Using GPS route distance:', finalDistance, 'km');
        } else {
            // Fall back to straight-line distance
            finalDistance = straightLineDistance;
            distanceSource = 'straight-line calculation';
            console.log('GPS tracking failed, using straight-line distance:', finalDistance, 'km');
        }
        
        // Apply custom rounding logic to the final distance
        const roundedDistance = roundDistance(finalDistance);
        
        console.log('Trip End - GPS Distance:', gpsDistance, 'km, Straight-line Distance:', straightLineDistance, 'km, Using:', finalDistance, 'km (', distanceSource, '), Rounded:', roundedDistance, 'km');
        console.log('Trip coordinates - Start:', trip.startLatitude, trip.startLongitude, 'End:', latitude, longitude);
        
        const user = await User.findOne({ email: req.userId });
        
        // Get both start and end area from coordinates to ensure they're included
        const startArea = trip.startArea || await getAreaFromCoordinates(trip.startLatitude, trip.startLongitude);
        const endArea = await getAreaFromCoordinates(latitude, longitude);
        
        // Calculate end odometer based on user input or GPS distance
        let newEndOdometer;
        if (userProvidedEndOdometer !== null && userProvidedEndOdometer !== undefined) {
            // User provided end odometer reading - use that as the new odometer value
            newEndOdometer = roundDistance(userProvidedEndOdometer);
            console.log('Using user-provided end odometer:', newEndOdometer, 'km');
        } else {
            // Use current odometer + calculated distance
            newEndOdometer = roundDistance(userData.currentOdometer + roundedDistance);
            console.log('Calculated end odometer from distance:', newEndOdometer, 'km');
        }
        
        const completedTrip = {
            ...trip,
            endDate: trip.startDate, 
            endLatitude: latitude,
            endLongitude: longitude,
            startArea: startArea,
            endArea: endArea,
            endTime: new Date().toISOString(),
            gpsDistance: gpsDistance || 0, // Store original GPS distance for reference
            endOdometer: newEndOdometer,
            totalDistance: roundedDistance,
            distanceSource: distanceSource, // Store how distance was calculated
            routePoints: trip.routePoints || [],
            active: false
        };
        
        // Save trip to Trip collection
        const tripDoc = new Trip(completedTrip);
        await tripDoc.save();
        
        // Update current odometer and remove active trip
        userData.currentOdometer = newEndOdometer;
        userData.activeTrip = null;
        await userData.save();
        
        // Write to CSV in Excel-compatible format (using stored area information)
        const csvData = {
            began: completedTrip.startDate,
            ended: completedTrip.endDate,
            purpose: completedTrip.purpose,
            areaFrom: completedTrip.startArea,
            areaTo: completedTrip.endArea,
            start: completedTrip.startOdometer,
            finish: completedTrip.endOdometer,
            kilometresTravelled: completedTrip.totalDistance,
            signatureEntry: '', // Empty as requested
            driverName: user.fullName,
            fbtYear: new Date().getFullYear() + 1, // Next FBT year
            dateOfEntry: new Date().toISOString().split('T')[0]
        };
        
        // Append to CSV
        try {
            if (!fs.existsSync(csvFile)) {
                csvWriter.writeRecords([csvData]);
            } else {
                const csvAppendWriter = createCsvWriter({
                    path: csvFile,
                    header: [
                        { id: 'began', title: 'Date Trip Began' },
                        { id: 'ended', title: 'Date Trip Ended' },
                        { id: 'purpose', title: 'Purpose of Trip' },
                        { id: 'areaFrom', title: 'Area From' },
                        { id: 'areaTo', title: 'Area To' },
                        { id: 'start', title: 'Odometer Reading Start' },
                        { id: 'finish', title: 'Odometer Reading Finish' },
                        { id: 'kilometresTravelled', title: 'Kilometres Travelled' },
                        { id: 'signatureEntry', title: 'Signature of person making Entry' },
                        { id: 'driverName', title: 'Name of Driver or Vehicle Registration No' },
                        { id: 'fbtYear', title: 'FBT Year Ending' },
                        { id: 'dateOfEntry', title: 'Date of Entry' }
                    ],
                    append: true
                });
                csvAppendWriter.writeRecords([csvData]);
            }
        } catch (csvError) {
            console.error('CSV write error:', csvError);
        }
        
        res.json({ 
            success: true, 
            trip: completedTrip,
            message: `Trip ended successfully! Distance: ${roundedDistance}km (${distanceSource}). Current odometer: ${Math.round(completedTrip.endOdometer)}km`
        });
    } catch (error) {
        console.error('Error ending trip:', error);
        res.status(500).json({ error: 'Failed to end trip' });
    }
});

// Update trip route (add GPS points during trip)
app.post('/api/trip/route', authenticateToken, async (req, res) => {
    try {
        const { latitude, longitude, accuracy } = req.body;
        
        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Location coordinates are required' });
        }
        
        const userData = await getUserData(req.userId);
        
        if (!userData.activeTrip) {
            return res.status(400).json({ error: 'No active trip found' });
        }
        
        // Add route point to active trip
        if (!userData.activeTrip.routePoints) {
            userData.activeTrip.routePoints = [];
        }
        
        userData.activeTrip.routePoints.push({
            latitude,
            longitude,
            accuracy: accuracy || 0,
            timestamp: new Date()
        });
        
        // Limit route points to prevent excessive storage (keep last 1000 points)
        if (userData.activeTrip.routePoints.length > 1000) {
            userData.activeTrip.routePoints = userData.activeTrip.routePoints.slice(-1000);
        }
        
        await userData.save();
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating trip route:', error);
        res.status(500).json({ error: 'Failed to update trip route' });
    }
});

// Get active trip
app.get('/api/trip/active', authenticateToken, async (req, res) => {
    try {
        const userData = await getUserData(req.userId);
        res.json({ activeTrip: userData.activeTrip || null });
    } catch (error) {
        console.error('Error fetching active trip:', error);
        res.status(500).json({ error: 'Failed to fetch active trip' });
    }
});

// Get trip history
app.get('/api/trips', authenticateToken, async (req, res) => {
    try {
        const trips = await Trip.find({ userId: req.userId }).sort({ startTime: -1 });
        res.json({ trips });
    } catch (error) {
        console.error('Error fetching trips:', error);
        res.status(500).json({ error: 'Failed to fetch trips' });
    }
});

// Delete a trip
app.delete('/api/trip/:tripId', authenticateToken, async (req, res) => {
    try {
        const { tripId } = req.params;
        
        if (!tripId) {
            return res.status(400).json({ error: 'Trip ID is required' });
        }
        
        const trip = await Trip.findOneAndDelete({ 
            id: parseInt(tripId), 
            userId: req.userId 
        });
        
        if (!trip) {
            return res.status(404).json({ error: 'Trip not found' });
        }
        
        res.json({ success: true, message: 'Trip deleted successfully' });
    } catch (error) {
        console.error('Error deleting trip:', error);
        res.status(500).json({ error: 'Failed to delete trip' });
    }
});

// Export trips to CSV for date range
app.post('/api/trips/export', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        
        // Validation
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Start date and end date are required' });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return res.status(400).json({ error: 'Invalid date format' });
        }

        if (start > end) {
            return res.status(400).json({ error: 'Start date must be before or equal to end date' });
        }

        const user = await User.findOne({ email: req.userId });

        // Filter trips by date range and user
        const filteredTrips = await Trip.find({
            userId: req.userId,
            startDate: { 
                $gte: startDate, 
                $lte: endDate 
            }
        }).sort({ startTime: 1 });

        if (filteredTrips.length === 0) {
            return res.status(404).json({ error: 'No trips found in the specified date range' });
        }

        // Create CSV filename with date range
        const startDateStr = startDate.replace(/-/g, '');
        const endDateStr = endDate.replace(/-/g, '');
        const filename = `Motor_Vehicle_Log_${startDateStr}_to_${endDateStr}.csv`;
        const filepath = path.join(__dirname, 'exports', filename);

        // Create exports directory if it doesn't exist
        const exportsDir = path.join(__dirname, 'exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }

        // Prepare CSV data with stored area information from database
        const csvData = filteredTrips.map(trip => ({
            began: trip.startDate,
            ended: trip.endDate,
            purpose: trip.purpose,
            areaFrom: trip.startArea || 'Unknown Area',
            areaTo: trip.endArea || 'Unknown Area',
            start: trip.startOdometer,
            finish: trip.endOdometer,
            kilometresTravelled: trip.totalDistance,
            signatureEntry: '', // Empty as requested
            driverName: user.fullName,
            fbtYear: new Date().getFullYear() + 1, // Next FBT year
            dateOfEntry: new Date(trip.startTime).toISOString().split('T')[0]
        }));

        // Create CSV writer for export
        const exportCsvWriter = createCsvWriter({
            path: filepath,
            header: [
                { id: 'began', title: 'Date Trip Began' },
                { id: 'ended', title: 'Date Trip Ended' },
                { id: 'purpose', title: 'Purpose of Trip' },
                { id: 'areaFrom', title: 'Area From' },
                { id: 'areaTo', title: 'Area To' },
                { id: 'start', title: 'Odometer Reading Start' },
                { id: 'finish', title: 'Odometer Reading Finish' },
                { id: 'kilometresTravelled', title: 'Kilometres Travelled' },
                { id: 'signatureEntry', title: 'Signature of person making Entry' },
                { id: 'dateOfEntry', title: 'Date of Entry' }
            ]
        });

        // Write CSV file
        await exportCsvWriter.writeRecords(csvData);

        // Send file as download
        res.download(filepath, filename, (err) => {
            if (err) {
                console.error('Download error:', err);
                res.status(500).json({ error: 'Failed to download file' });
            } else {
                // Clean up file after download
                setTimeout(() => {
                    try {
                        fs.unlinkSync(filepath);
                    } catch (cleanupError) {
                        console.error('Cleanup error:', cleanupError);
                    }
                }, 30000); // Delete after 30 seconds
            }
        });

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Failed to export trips' });
    }
});

app.listen(PORT, () => {
    console.log(`TripGo server is running on port ${PORT}`);
    console.log(`Access the app at: http://localhost:${PORT}`);
});
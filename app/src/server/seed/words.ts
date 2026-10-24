// Word lists for the generator. ASCII only, so ILIKE and lower() behave the same on both engines.

export const FIRST_NAMES = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth',
  'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen',
  'Daniel', 'Nancy', 'Matthew', 'Lisa', 'Anthony', 'Betty', 'Mark', 'Margaret', 'Donald', 'Sandra',
  'Steven', 'Ashley', 'Paul', 'Kimberly', 'Andrew', 'Emily', 'Joshua', 'Donna', 'Kenneth', 'Michelle',
  'Kevin', 'Carol', 'Brian', 'Amanda', 'George', 'Melissa', 'Timothy', 'Deborah', 'Ronald', 'Stephanie',
  'Jason', 'Rebecca', 'Edward', 'Laura', 'Jeffrey', 'Sharon', 'Ryan', 'Cynthia', 'Jacob', 'Kathleen',
  'Gary', 'Amy', 'Nicholas', 'Shirley', 'Eric', 'Angela', 'Jonathan', 'Helen', 'Stephen', 'Anna',
  'Larry', 'Brenda', 'Justin', 'Pamela', 'Scott', 'Nicole', 'Brandon', 'Samantha', 'Benjamin', 'Katherine',
  'Samuel', 'Emma', 'Gregory', 'Ruth', 'Alexander', 'Christine', 'Frank', 'Catherine', 'Patrick', 'Debra',
  'Raymond', 'Rachel', 'Jack', 'Carolyn', 'Dennis', 'Janet', 'Jerry', 'Virginia', 'Tyler', 'Maria',
  'Aaron', 'Heather', 'Jose', 'Diane', 'Adam', 'Julie', 'Henry', 'Joyce', 'Nathan', 'Victoria',
  'Lars', 'Astrid', 'Erik', 'Ingrid', 'Johan', 'Freja', 'Oskar', 'Elsa', 'Nils', 'Maja',
  'Lukas', 'Lena', 'Felix', 'Hannah', 'Jonas', 'Leonie', 'Pierre', 'Camille', 'Hugo', 'Chloe',
  'Luca', 'Giulia', 'Marco', 'Francesca', 'Pablo', 'Lucia', 'Javier', 'Sofia', 'Mateo', 'Valentina',
  'Rafael', 'Beatriz', 'Arjun', 'Priya', 'Rohan', 'Ananya', 'Kenji', 'Yuki', 'Haruto', 'Sakura',
];

export const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
  'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes',
  'Stewart', 'Morris', 'Morales', 'Murphy', 'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper',
  'Peterson', 'Bailey', 'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson',
  'Watson', 'Brooks', 'Chavez', 'Wood', 'James', 'Bennett', 'Gray', 'Mendoza', 'Ruiz', 'Hughes',
  'Price', 'Alvarez', 'Castillo', 'Sanders', 'Patel', 'Myers', 'Long', 'Ross', 'Foster', 'Jimenez',
  'Powell', 'Jenkins', 'Perry', 'Russell', 'Sullivan', 'Bell', 'Coleman', 'Butler', 'Henderson', 'Barnes',
  'Gonzales', 'Fisher', 'Vasquez', 'Simmons', 'Romero', 'Jordan', 'Patterson', 'Alexander', 'Hamilton', 'Graham',
  'Andersson', 'Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson', 'Olsson', 'Persson', 'Svensson', 'Gustafsson',
  'Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
  'Dubois', 'Durand', 'Leroy', 'Moreau', 'Laurent', 'Simon', 'Michel', 'Lefebvre', 'Bernard', 'Petit',
  'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco',
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Pereira', 'Costa', 'Almeida', 'Ferreira', 'Carvalho', 'Gomes',
  'Sharma', 'Singh', 'Kumar', 'Gupta', 'Mehta', 'Reddy', 'Iyer', 'Rao', 'Das', 'Joshi',
  'Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato',
  'Visser', 'De Jong', 'Bakker', 'Janssen', 'Smit', 'Mulder', 'Bos', 'Vos', 'Dekker', 'Peters',
];

export const EMAIL_DOMAINS: [string, number][] = [
  ['gmail.com', 38], ['outlook.com', 12], ['yahoo.com', 10], ['hotmail.com', 8], ['icloud.com', 9],
  ['proton.me', 4], ['gmx.de', 4], ['web.de', 3], ['orange.fr', 3], ['libero.it', 2],
  ['mail.com', 2], ['fastmail.com', 2], ['example.org', 3],
];

export interface Country {
  name: string;
  weight: number;
  cardShare: number;
  cities: string[];
}

export const COUNTRIES: Country[] = [
  { name: 'United States', weight: 30, cardShare: 0.72, cities: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'San Francisco', 'San Diego', 'San Jose', 'San Antonio', 'Seattle', 'Boston', 'Austin', 'Denver', 'Miami'] },
  { name: 'United Kingdom', weight: 9, cardShare: 0.68, cities: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Bristol', 'Edinburgh', 'Liverpool'] },
  { name: 'Germany', weight: 9, cardShare: 0.42, cities: ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Dusseldorf', 'Leipzig'] },
  { name: 'France', weight: 7, cardShare: 0.62, cities: ['Paris', 'Marseille', 'Lyon', 'Toulouse', 'Nice', 'Nantes', 'Bordeaux', 'Lille'] },
  { name: 'Brazil', weight: 6, cardShare: 0.64, cities: ['Sao Paulo', 'Rio de Janeiro', 'Brasilia', 'Salvador', 'Fortaleza', 'Santos', 'Curitiba'] },
  { name: 'India', weight: 6, cardShare: 0.5, cities: ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune'] },
  { name: 'Canada', weight: 5, cardShare: 0.7, cities: ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Ottawa', 'Edmonton'] },
  { name: 'Spain', weight: 5, cardShare: 0.6, cities: ['Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Malaga', 'Santander', 'San Sebastian'] },
  { name: 'Italy', weight: 5, cardShare: 0.58, cities: ['Rome', 'Milan', 'Naples', 'Turin', 'Palermo', 'Bologna', 'Florence'] },
  { name: 'Japan', weight: 5, cardShare: 0.66, cities: ['Tokyo', 'Osaka', 'Yokohama', 'Nagoya', 'Sapporo', 'Fukuoka', 'Kyoto'] },
  { name: 'Australia', weight: 5, cardShare: 0.74, cities: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra'] },
  { name: 'Sweden', weight: 4, cardShare: 0.55, cities: ['Stockholm', 'Gothenburg', 'Malmo', 'Uppsala', 'Vasteras', 'Orebro'] },
  { name: 'Netherlands', weight: 4, cardShare: 0.38, cities: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven'] },
];

// category → [weight, min price cents, max price cents]
export const CATEGORY_PRICES: Record<string, [number, number, number]> = {
  electronics: [12, 2_000, 150_000],
  books: [10, 500, 6_000],
  clothing: [16, 1_000, 20_000],
  home: [12, 1_500, 50_000],
  beauty: [9, 500, 8_000],
  sports: [8, 1_000, 40_000],
  toys: [7, 800, 12_000],
  grocery: [14, 200, 5_000],
  garden: [5, 1_000, 30_000],
  automotive: [7, 1_500, 60_000],
};

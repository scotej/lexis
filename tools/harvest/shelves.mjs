/**
 * What to go and get: the works whose quotes are worth having.
 *
 * This file is the single biggest lever on corpus quality, and it is a
 * judgement call rather than an algorithm. Wikiquote will happily hand over
 * eight hundred thousand television lines; the large majority are scene filler
 * from shows nobody has heard of, and a crawl that took them all would produce
 * a corpus that was enormous and worthless. Choosing the shelf first is what
 * makes the difference between "quotes" and "lines of dialogue".
 *
 * The bias is deliberate and twofold:
 *
 *   1. Recognisable. A quote you have met before is worth typing in a way a
 *      random sentence is not — you get the small pleasure of recognition, and
 *      the words stick.
 *   2. Useful to a VCE English student. That means the set texts and the
 *      writers they are compared against get far more room than box-office
 *      ranking alone would give them, and it means philosophy, rhetoric and
 *      essays are in here at all.
 *
 * Adding a title here is how the corpus grows. Nothing else needs changing.
 */

/* ---- films ---- */

export const FILMS = [
  // the most-quoted films in the language
  "Casablanca", "The Godfather", "The Godfather Part II", "Citizen Kane", "Gone with the Wind",
  "The Wizard of Oz", "Sunset Boulevard", "Some Like It Hot", "Singin' in the Rain",
  "Lawrence of Arabia", "Dr. Strangelove", "The Apartment", "12 Angry Men", "On the Waterfront",
  "All About Eve", "Double Indemnity", "The Third Man", "Rear Window", "Vertigo", "Psycho",
  "North by Northwest", "The Maltese Falcon", "It's a Wonderful Life", "Chinatown",
  "Taxi Driver", "Apocalypse Now", "Network", "Cool Hand Luke", "Butch Cassidy and the Sundance Kid",
  "The Treasure of the Sierra Madre", "A Streetcar Named Desire", "Rebel Without a Cause",

  // modern canon
  "The Shawshank Redemption", "Pulp Fiction", "Fight Club", "Goodfellas", "Schindler's List",
  "Forrest Gump", "The Silence of the Lambs", "The Usual Suspects", "Se7en", "Heat",
  "The Big Lebowski", "No Country for Old Men", "There Will Be Blood", "The Departed",
  "American Beauty", "Good Will Hunting", "A Few Good Men", "Jerry Maguire", "Scent of a Woman",
  "Glengarry Glen Ross", "The Social Network", "Whiplash", "Birdman", "Her", "Arrival",
  "Parasite", "Everything Everywhere All at Once", "Oppenheimer", "Dune", "The Green Mile",
  "Gladiator", "Braveheart", "Saving Private Ryan", "Full Metal Jacket", "Platoon",
  "The Truman Show", "Groundhog Day", "Dead Poets Society", "The Breakfast Club",
  "Ferris Bueller's Day Off", "Rain Man", "Philadelphia", "Erin Brockovich", "Spotlight",

  // science fiction and fantasy
  "Blade Runner", "2001: A Space Odyssey", "The Matrix", "Alien", "Aliens", "The Terminator",
  "Terminator 2: Judgment Day", "Star Wars", "The Empire Strikes Back", "Return of the Jedi",
  "Jurassic Park", "Back to the Future", "E.T. the Extra-Terrestrial", "Close Encounters of the Third Kind",
  "The Lord of the Rings: The Fellowship of the Ring", "The Lord of the Rings: The Two Towers",
  "The Lord of the Rings: The Return of the King", "Interstellar", "Inception", "Memento",
  "The Prestige", "Eternal Sunshine of the Spotless Mind", "Children of Men", "Gattaca",
  "Minority Report", "The Fifth Element", "Twelve Monkeys", "Brazil", "Metropolis",
  "The Dark Knight", "Batman Begins", "The Dark Knight Rises", "Watchmen", "V for Vendetta",
  "Spider-Man", "Iron Man", "The Avengers", "Black Panther", "Logan",

  // comedy and animation
  "Monty Python and the Holy Grail", "Life of Brian", "Airplane!", "The Princess Bride",
  "Ghostbusters", "Blazing Saddles", "Young Frankenstein", "Anchorman", "Office Space",
  "Shrek", "Toy Story", "Toy Story 3", "Finding Nemo", "The Incredibles", "Up", "WALL-E",
  "Ratatouille", "Inside Out", "Coco", "The Lion King", "Beauty and the Beast", "Aladdin",
  "Mulan", "Spirited Away", "Princess Mononoke", "Howl's Moving Castle", "My Neighbor Totoro",
  "Spider-Man: Into the Spider-Verse", "Kung Fu Panda", "How to Train Your Dragon",

  // adaptations a VCE student is likely to meet
  "To Kill a Mockingbird", "One Flew Over the Cuckoo's Nest", "The Great Gatsby",
  "Pride and Prejudice", "Sense and Sensibility", "Emma", "Atonement", "The Remains of the Day",
  "Never Let Me Go", "The Handmaid's Tale", "1984", "Fahrenheit 451", "Lord of the Flies",
  "The Crucible", "Of Mice and Men", "The Grapes of Wrath", "A Clockwork Orange",
  "The Colour Purple", "Beloved", "The Kite Runner", "Life of Pi", "Slumdog Millionaire",
  "Rabbit-Proof Fence", "The Dressmaker", "Picnic at Hanging Rock", "Gallipoli",
  "Mad Max", "Mad Max 2", "Mad Max: Fury Road", "Muriel's Wedding", "The Castle",
  "Romeo + Juliet", "Hamlet", "Macbeth", "Henry V", "Much Ado About Nothing",
  "Twelve Angry Men", "In Cold Blood", "Capote", "Selma", "12 Years a Slave",
  "Hidden Figures", "The Imitation Game", "A Beautiful Mind", "The Theory of Everything",
];

/* ---- television ---- */

export const SHOWS = [
  // the ones people actually quote
  "The Wire", "Breaking Bad", "Better Call Saul", "The Sopranos", "Mad Men", "The West Wing",
  "Game of Thrones", "Succession", "Six Feet Under", "Deadwood", "True Detective",
  "Fargo", "Chernobyl", "Band of Brothers", "The Leftovers", "Twin Peaks", "Lost",
  "Battlestar Galactica", "Firefly", "Star Trek: The Next Generation", "Star Trek",
  "Doctor Who", "The Twilight Zone", "Black Mirror", "Westworld", "The Expanse",
  "Sherlock", "House", "The X-Files", "Buffy the Vampire Slayer", "Angel",
  "Better Things", "Halt and Catch Fire", "Rectify", "The Americans", "Mr. Robot",

  // comedy
  "Seinfeld", "Frasier", "Cheers", "Friends", "The Office", "The Office (U.S. TV series)",
  "Parks and Recreation", "30 Rock", "Arrested Development", "Community", "Scrubs",
  "How I Met Your Mother", "Brooklyn Nine-Nine", "The Good Place", "Ted Lasso",
  "Schitt's Creek", "Fleabag", "Derry Girls", "Peep Show", "Blackadder", "Fawlty Towers",
  "Monty Python's Flying Circus", "Yes Minister", "Yes, Prime Minister", "The Thick of It",
  "Curb Your Enthusiasm", "Veep", "Silicon Valley", "Barry", "Atlanta", "Bojack Horseman",
  "The Simpsons", "Futurama", "King of the Hill", "Bob's Burgers", "Kath & Kim",
  "Utopia", "Summer Heights High", "The IT Crowd", "Spaced", "Black Books",

  // drama and prestige
  "Downton Abbey", "The Crown", "Call the Midwife", "Poldark", "Peaky Blinders",
  "Line of Duty", "Broadchurch", "Happy Valley", "Bodyguard", "The Handmaid's Tale",
  "Stranger Things", "The Queen's Gambit", "Normal People", "Euphoria", "This Is Us",
  "Grey's Anatomy", "ER", "The Newsroom", "Homeland", "24", "Dexter", "Sons of Anarchy",
  "Vikings", "Rome", "The Last Kingdom", "Outlander", "Anne with an E", "Heartstopper",
];

/* ---- books, plays and poems ---- */

export const BOOKS = [
  // VCA/VCE set texts and their neighbours
  "Nineteen Eighty-Four", "Animal Farm", "Brave New World", "Fahrenheit 451",
  "The Handmaid's Tale", "Never Let Me Go", "The Remains of the Day", "Klara and the Sun",
  "The Great Gatsby", "To Kill a Mockingbird", "Of Mice and Men", "The Grapes of Wrath",
  "The Catcher in the Rye", "Lord of the Flies", "The Crucible", "Death of a Salesman",
  "A Streetcar Named Desire", "The Glass Menagerie", "Waiting for Godot", "A Doll's House",
  "Hedda Gabler", "An Enemy of the People", "Medea", "Antigone", "Oedipus Rex",
  "The Bacchae", "The Women of Troy", "Twelve Angry Men", "Rhinoceros",

  // Shakespeare
  "Hamlet", "Macbeth", "King Lear", "Othello", "Romeo and Juliet", "Julius Caesar",
  "The Tempest", "A Midsummer Night's Dream", "Much Ado About Nothing", "Twelfth Night",
  "The Merchant of Venice", "As You Like It", "Richard III", "Henry V", "Coriolanus",
  "Measure for Measure", "The Winter's Tale", "Antony and Cleopatra",

  // the nineteenth century
  "Pride and Prejudice", "Sense and Sensibility", "Emma", "Persuasion", "Mansfield Park",
  "Jane Eyre", "Wuthering Heights", "The Tenant of Wildfell Hall", "Middlemarch",
  "Great Expectations", "A Tale of Two Cities", "Bleak House", "Hard Times", "Oliver Twist",
  "David Copperfield", "Frankenstein", "Dracula", "The Picture of Dorian Gray",
  "The Importance of Being Earnest", "Strange Case of Dr Jekyll and Mr Hyde",
  "Moby-Dick", "The Scarlet Letter", "Adventures of Huckleberry Finn", "Walden",
  "Crime and Punishment", "The Brothers Karamazov", "Anna Karenina", "War and Peace",
  "Madame Bovary", "Les Miserables", "The Count of Monte Cristo", "Don Quixote",

  // the twentieth century and after
  "Heart of Darkness", "Things Fall Apart", "Beloved", "The Bluest Eye", "Song of Solomon",
  "Invisible Man", "Native Son", "Go Tell It on the Mountain", "The Colour Purple",
  "Their Eyes Were Watching God", "One Hundred Years of Solitude", "Love in the Time of Cholera",
  "The Trial", "The Metamorphosis", "The Stranger", "The Myth of Sisyphus", "The Plague",
  "Nausea", "Mrs Dalloway", "To the Lighthouse", "A Room of One's Own", "Orlando",
  "Ulysses", "Dubliners", "A Portrait of the Artist as a Young Man", "The Waste Land",
  "Catch-22", "Slaughterhouse-Five", "On the Road", "The Bell Jar", "The Road",
  "Blood Meridian", "Beloved", "Midnight's Children", "The God of Small Things",
  "A Fine Balance", "The Kite Runner", "Life of Pi", "The Book Thief", "Cloud Atlas",
  "The Sellout", "Normal People", "Small Things Like These", "Shuggie Bain",

  // Australian
  "Cloudstreet", "The Secret River", "Burial Rites", "Jasper Jones", "The Dressmaker",
  "Picnic at Hanging Rock", "My Brilliant Career", "The Fortunes of Richard Mahony",
  "Voss", "The Tree of Man", "Oscar and Lucinda", "True History of the Kelly Gang",
  "Carpentaria", "Too Much Lip", "The Yield", "Growing Up Aboriginal in Australia",

  // children's and young adult that adults still quote
  "Alice's Adventures in Wonderland", "Through the Looking-Glass", "The Little Prince",
  "Winnie-the-Pooh", "The Wind in the Willows", "Charlotte's Web", "Matilda",
  "Harry Potter and the Philosopher's Stone", "The Hobbit", "The Lord of the Rings",
  "The Lion, the Witch and the Wardrobe", "A Wrinkle in Time", "The Giver",
  "The Hunger Games", "The Fault in Our Stars", "The Perks of Being a Wallflower",
];

/* ---- people worth quoting ---- */

export const PEOPLE = [
  // writers
  "Oscar Wilde", "Virginia Woolf", "James Baldwin", "Toni Morrison", "Maya Angelou",
  "George Orwell", "Franz Kafka", "Fyodor Dostoevsky", "Leo Tolstoy", "Anton Chekhov",
  "Jane Austen", "Charlotte Bronte", "Emily Dickinson", "Walt Whitman", "Mark Twain",
  "Ernest Hemingway", "F. Scott Fitzgerald", "William Faulkner", "John Steinbeck",
  "Kurt Vonnegut", "Ray Bradbury", "Ursula K. Le Guin", "Isaac Asimov", "Arthur C. Clarke",
  "Douglas Adams", "Terry Pratchett", "Neil Gaiman", "Margaret Atwood", "Zadie Smith",
  "Chimamanda Ngozi Adichie", "Salman Rushdie", "Kazuo Ishiguro", "Cormac McCarthy",
  "Joan Didion", "Susan Sontag", "Hannah Arendt", "Simone de Beauvoir", "Audre Lorde",
  "bell hooks", "Rebecca Solnit", "Ta-Nehisi Coates", "David Foster Wallace",
  "Christopher Hitchens", "Umberto Eco", "Italo Calvino", "Jorge Luis Borges",
  "Gabriel Garcia Marquez", "Pablo Neruda", "Rainer Maria Rilke", "T. S. Eliot",
  "W. H. Auden", "Seamus Heaney", "Sylvia Plath", "Langston Hughes", "Robert Frost",
  "William Blake", "John Keats", "Percy Bysshe Shelley", "Lord Byron", "William Wordsworth",
  "Samuel Taylor Coleridge", "John Donne", "John Milton", "Alexander Pope", "Samuel Johnson",

  // thinkers
  "Socrates", "Plato", "Aristotle", "Epictetus", "Seneca the Younger", "Marcus Aurelius",
  "Confucius", "Lao Tzu", "Sun Tzu", "Michel de Montaigne", "Rene Descartes",
  "Baruch Spinoza", "John Locke", "David Hume", "Immanuel Kant", "Jean-Jacques Rousseau",
  "Voltaire", "Georg Wilhelm Friedrich Hegel", "Arthur Schopenhauer", "Soren Kierkegaard",
  "Friedrich Nietzsche", "Karl Marx", "John Stuart Mill", "Bertrand Russell",
  "Ludwig Wittgenstein", "Albert Camus", "Jean-Paul Sartre", "Michel Foucault",
  "Noam Chomsky", "Isaiah Berlin", "Martha Nussbaum", "Peter Singer", "Judith Butler",
  "Edward Said", "Frantz Fanon", "Antonio Gramsci", "Slavoj Zizek",

  // science
  "Albert Einstein", "Isaac Newton", "Charles Darwin", "Marie Curie", "Richard Feynman",
  "Carl Sagan", "Stephen Hawking", "Neil deGrasse Tyson", "Jane Goodall", "Rachel Carson",
  "Alan Turing", "Ada Lovelace", "Nikola Tesla", "Galileo Galilei", "Rosalind Franklin",
  "Barbara McClintock", "E. O. Wilson", "Oliver Sacks", "Primo Levi", "Jacob Bronowski",

  // public life
  "Abraham Lincoln", "Winston Churchill", "Franklin D. Roosevelt", "John F. Kennedy",
  "Martin Luther King Jr.", "Malcolm X", "Nelson Mandela", "Mahatma Gandhi",
  "Rosa Parks", "Frederick Douglass", "Sojourner Truth", "Harriet Tubman",
  "Emmeline Pankhurst", "Susan B. Anthony", "Eleanor Roosevelt", "Ruth Bader Ginsburg",
  "Barack Obama", "Vaclav Havel", "Aung San Suu Kyi", "Desmond Tutu", "Malala Yousafzai",
  "Greta Thunberg", "Gough Whitlam", "Paul Keating", "Julia Gillard", "Noel Pearson",
  "Stan Grant", "Adam Goodes", "Cathy Freeman",

  // art and elsewhere
  "Leonardo da Vinci", "Vincent van Gogh", "Pablo Picasso", "Frida Kahlo",
  "Ludwig van Beethoven", "Wolfgang Amadeus Mozart", "Johann Sebastian Bach",
  "Alfred Hitchcock", "Akira Kurosawa", "Ingmar Bergman", "Federico Fellini",
  "Orson Welles", "Stanley Kubrick", "Agnes Varda", "Roger Ebert", "Bruce Lee",
];

/* ---- speeches, for the long and thicc buckets ---- */

export const SPEECHES = [
  "I Have a Dream", "Gettysburg Address", "Second Inaugural Address of Abraham Lincoln",
  "We shall fight on the beaches", "Their finest hour", "Blood, toil, tears and sweat",
  "Inaugural Address of John F. Kennedy", "We choose to go to the Moon",
  "I Am Prepared to Die", "Nelson Mandela's inauguration speech",
  "Ain't I a Woman?", "The Ballot or the Bullet", "A Time to Break Silence",
  "The Man in the Arena", "Freedom from Fear", "Four Freedoms",
  "The Redfern Speech", "Julia Gillard misogyny speech",
  "This is Water", "Commencement address", "Address to the Nation",
  "Areopagitica", "A Vindication of the Rights of Woman", "The Rights of Man",
  "Common Sense", "Civil Disobedience", "Self-Reliance", "Nature",
  "Politics and the English Language", "Shooting an Elephant", "Why I Write",
  "A Room of One's Own", "The Second Sex", "Letter from Birmingham Jail",
];

/** Wikiquote themes worth having as a shelf of their own. */
export const TOPICS = [
  "English proverbs", "Latin proverbs", "Chinese proverbs", "African proverbs",
  "Japanese proverbs", "Irish proverbs", "Russian proverbs", "Arabic proverbs",
  "Courage", "Freedom", "Justice", "Truth", "Wisdom", "Education", "Knowledge",
  "Language", "Literature", "Writing", "Reading", "Poetry", "Art", "Music",
  "Time", "Memory", "Death", "Grief", "Love", "Friendship", "Solitude", "Silence",
  "Power", "War", "Peace", "Democracy", "Liberty", "Equality", "Human rights",
  "Science", "Nature", "Change", "Failure", "Ambition", "Work", "Money", "Happiness",
  "Hope", "Fear", "Doubt", "Conscience", "Morality", "Ethics", "Character",
];

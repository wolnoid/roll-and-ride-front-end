// import { useContext } from 'react';
// import { UserContext } from './contexts/UserContext';
import { Routes, Route } from "react-router";
import NavBar from "./components/NavBar/NavBar";
import SignUpForm from "./components/SignUpForm/SignUpForm";
import SignInForm from "./components/SignInForm/SignInForm";
import Landing from "./components/Landing/Landing";
import { useMapsLoader } from "./hooks/useMapsLoader";

const App = () => {
  useMapsLoader();
  // const { user } = useContext(UserContext);

  return (
    <>
      <NavBar />
      <Routes>
        <Route path='/' element={<Landing />} />
        <Route path='/sign-up' element={<SignUpForm />} />
        <Route path='/sign-in' element={<SignInForm />} />
      </Routes>
    </>
  );
};

export default App;




// import { useContext, useState, useEffect } from 'react';
// import { Routes, Route, useNavigate } from 'react-router';
// import { UserContext } from './contexts/UserContext';

// import Dashboard from './components/Dashboard/Dashboard';
// import HootList from './components/HootList/HootList';
// import HootDetails from './components/HootDetails/HootDetails';
// import HootForm from './components/HootForm/HootForm';
// import CommentForm from './components/CommentForm/CommentForm';
// import * as hootService from './services/hootService';

// const App = () => {
//   const { user } = useContext(UserContext);
//   const [hoots, setHoots] = useState([]);

//   useEffect(() => {
//     const fetchAllHoots = async () => {
//       const hootsData = await hootService.index();
  
//       setHoots(hootsData);
//     };
//     if (user) fetchAllHoots();
//   }, [user]);

//   const navigate = useNavigate();

//   const handleAddHoot = async (hootFormData) => {
//     const newHoot = await hootService.create(hootFormData);
//     setHoots([newHoot, ...hoots]);
//     navigate('/hoots');
//   };

//   const handleDeleteHoot = async (hootId) => {
//     const deletedHoot = await hootService.deleteHoot(hootId);
//     setHoots(hoots.filter((hoot) => hoot._id !== deletedHoot._id));
//     navigate('/hoots');
//   };

//   const handleUpdateHoot = async (hootId, hootFormData) => {
//     const updatedHoot = await hootService.update(hootId, hootFormData);
//     setHoots(hoots.map((hoot) => (hootId === hoot._id ? updatedHoot : hoot)));
//     navigate(`/hoots/${hootId}`);
//   };
  
//   return (
//     <>
//       <NavBar/>
//       <Routes>
//         <Route path='/' element={<Landing />} />
//         {user ? (
//           <>
//             {/* Protected Routes (available only to signed-in users) */}
//             <Route path='/hoots' element={<HootList hoots={hoots}/>} />
//             <Route 
//               path='/hoots/:hootId'
//               element={<HootDetails handleDeleteHoot={handleDeleteHoot}/>}
//             />
//             <Route 
//               path='/hoots/new' 
//               element={<HootForm handleAddHoot={handleAddHoot} />}
//             />
//             {/* Pass the new handleUpdateHoot function */}
//             <Route
//               path='/hoots/:hootId/edit'
//               element={<HootForm handleUpdateHoot={handleUpdateHoot}/>}
//             />
//             <Route
//               path='/hoots/:hootId/comments/:commentId/edit'
//               element={<CommentForm />}
//             />
//           </>
//         ) : (
//           <>
//             {/* Non-user routes (available only to guests) */}
//             <Route path='/sign-up' element={<SignUpForm />} />
//             <Route path='/sign-in' element={<SignInForm />} />
//           </>
//         )}
//       </Routes>
//     </>
//   );
// };

// export default App;